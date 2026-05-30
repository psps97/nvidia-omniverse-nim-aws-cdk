import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { OmniverseConfig } from './config';
import { buildUserData } from './user-data';

export interface OmniverseNimStackProps extends cdk.StackProps {
  config: OmniverseConfig;
}

// SSM public parameter — 항상 최신 DLAMI(Ubuntu 22.04, OSS NVIDIA driver) 조회.
const DLAMI_SSM_PARAM =
  '/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id';

export class OmniverseNimStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OmniverseNimStackProps) {
    super(scope, id, props);
    const { config } = props;
    const region = this.region;

    // ---------- 공통 태그 (CLAUDE.md 8-1) ----------
    cdk.Tags.of(this).add('Project', config.projectTag);
    cdk.Tags.of(this).add('Environment', 'poc');
    cdk.Tags.of(this).add('ManagedBy', 'cdk');
    if (config.ownerTag) cdk.Tags.of(this).add('Owner', config.ownerTag);

    const isPublic = config.deploymentMode === 'public';

    // ---------- VPC (그룹 A: 독립) ----------
    const vpc = this.resolveVpc(config);

    // ---------- Secrets (그룹 A: 독립, 동시 생성) ----------
    const dcvSecret = new secretsmanager.Secret(this, 'DcvPasswordSecret', {
      description: 'Amazon DCV 접속 비밀번호 (ubuntu)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'ubuntu' }),
        generateStringKey: 'password',
        passwordLength: 24,
        excludePunctuation: true,
      },
    });
    // NGC API Key 시크릿.
    //  - ngcSecretArn 지정 시: 미리 키를 넣어 만든 기존 시크릿 사용 (권장 — 부팅 중 pull 성공).
    //  - 미지정 시: 플레이스홀더 시크릿 생성 (배포 후 수동 키 주입 필요).
    const ngcSecret: secretsmanager.ISecret = config.ngcSecretArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'NgcApiKeySecret', config.ngcSecretArn)
      : new secretsmanager.Secret(this, 'NgcApiKeySecret', {
          description: 'NGC API Key (nvcr.io NIM pull). 배포 후 실제 키로 교체 필요.',
          secretStringValue: cdk.SecretValue.unsafePlainText('REPLACE_WITH_NGC_API_KEY'),
        });

    // ---------- CloudWatch Log Group (그룹 A) ----------
    const logGroup = new logs.LogGroup(this, 'BootstrapLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---------- IAM Role / Instance Profile (그룹 A) ----------
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Omniverse PoC EC2 instance role (least privilege)',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
      ],
    });
    // Secrets 읽기 (해당 ARN 한정)
    dcvSecret.grantRead(role);
    ngcSecret.grantRead(role);
    // (옵션) 사내 CA DCV 인증서 시크릿 — 지정 시 읽기 권한 부여
    if (config.dcvCertSecretArn) {
      const certSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        'DcvCertSecret',
        config.dcvCertSecretArn,
      );
      certSecret.grantRead(role);
    }
    // S3 자산 버킷 (지정 시)
    if (config.assetBucketName) {
      const bucketArn = `arn:${this.partition}:s3:::${config.assetBucketName}`;
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:DeleteObject'],
          resources: [bucketArn, `${bucketArn}/*`],
        }),
      );
    }
    // ECR (미러링/풀) — GetAuthorizationToken은 리소스 * 필요
    role.addToPolicy(
      new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }),
    );

    // ---------- Security Group (그룹 A) ----------
    const sg = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'Omniverse PoC - SSH/DCV/Web/WebRTC (restricted to allowedCidr)',
      allowAllOutbound: true, // NGC/pypi.nvidia.com 등 아웃바운드 필수 (섹션 3)
    });
    this.addIngressRules(sg, config);

    // ---------- EC2 (그룹 B: A에 의존) ----------
    const userData = buildUserData({
      config,
      dcvSecretArn: dcvSecret.secretArn,
      ngcSecretArn: ngcSecret.secretArn,
      region,
      logGroupName: logGroup.logGroupName,
    });

    const subnet = this.resolveSubnet(config, vpc);

    const instance = new ec2.Instance(this, 'OmniverseInstance', {
      vpc,
      vpcSubnets: { subnets: [subnet] },
      instanceType: new ec2.InstanceType(config.instanceType),
      machineImage: ec2.MachineImage.fromSsmParameter(DLAMI_SSM_PARAM, {
        os: ec2.OperatingSystemType.LINUX,
      }),
      securityGroup: sg,
      role,
      userData,
      requireImdsv2: true, // IMDSv2 강제
      detailedMonitoring: true,
      keyPair: config.keyPairName
        ? ec2.KeyPair.fromKeyPairName(this, 'KeyPair', config.keyPairName)
        : undefined,
      blockDevices: [
        {
          deviceName: '/dev/sda1', // Ubuntu DLAMI 루트
          volume: ec2.BlockDeviceVolume.ebs(config.rootVolumeSizeGb, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            iops: 6000,
            // throughput은 EC2 직접 지정 시 미지원(Launch Template 필요) → gp3 기본(125+) 사용.
            encrypted: true, // EBS 기본 암호화 (KMS)
            deleteOnTermination: !config.retainDataOnDelete,
          }),
        },
      ],
    });

    // 주의: cfn-signal/CreationPolicy 미사용.
    //  - Ubuntu DLAMI에는 /opt/aws/bin/cfn-signal(cfn-bootstrap)이 없어 신호가 안 감.
    //  - 부트스트랩은 graceful degrade(설치 실패해도 WARN 후 계속) 설계 →
    //    "인스턴스 실행 = 배포 성공"으로 보고, 설치 결과는 /var/log/omniverse-bootstrap.log
    //    + CloudWatch + DCV 접속 후 진단 체크리스트(CLAUDE.md 5-0)로 확인한다.

    // ---------- public 모드: EIP 고정 (그룹 C) ----------
    if (isPublic) {
      const eip = new ec2.CfnEIP(this, 'InstanceEip', { domain: 'vpc' });
      new ec2.CfnEIPAssociation(this, 'InstanceEipAssoc', {
        allocationId: eip.attrAllocationId,
        instanceId: instance.instanceId,
      });
      new cdk.CfnOutput(this, 'PublicIp', {
        value: eip.ref,
        description: 'EIP (고정 공인 IP) — SSH/DCV 접속 주소',
      });
    } else {
      new cdk.CfnOutput(this, 'PrivateIp', {
        value: instance.instancePrivateIp,
        description: '고정 프라이빗 IP — 사내망(VPN/DX) 접속 주소',
      });
    }

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'DcvSecretArn', {
      value: dcvSecret.secretArn,
      description: 'DCV 비밀번호 시크릿 (콘솔/CLI로 조회)',
    });
    new cdk.CfnOutput(this, 'NgcSecretArn', {
      value: ngcSecret.secretArn,
      description: 'NGC API Key 시크릿 — 배포 후 실제 키로 교체',
    });
    new cdk.CfnOutput(this, 'DcvUrl', {
      value: `https://<INSTANCE_IP>:8443`,
      description: 'Amazon DCV 접속 (위 IP로 치환)',
    });

    // dcvSecret은 항상 CDK 생성. ngcSecret은 ngcSecretArn 미지정 시에만 생성.
    const createdSecrets: secretsmanager.Secret[] = [dcvSecret];
    if (!config.ngcSecretArn) createdSecrets.push(ngcSecret as secretsmanager.Secret);
    this.addNagSuppressions(role, sg, createdSecrets);
  }

  // ---------- VPC 참조/생성 ----------
  private resolveVpc(config: OmniverseConfig): ec2.IVpc {
    if (config.createVpc) {
      // public 테스트용 신규 VPC (서울 2a/2b)
      const testVpc = new ec2.Vpc(this, 'TestVpc', {
        maxAzs: 2,
        natGateways: 1,
        ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
        subnetConfiguration: [
          { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 20 },
          { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
        ],
      });
      // VPC Flow Log (cdk-nag AwsSolutions-VPC7)
      testVpc.addFlowLog('FlowLog');
      return testVpc;
    }
    // 기존 VPC 참조
    return ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: config.vpcId!,
      // 서울 2a/2b. 서브넷은 명시 ID로 별도 참조.
      availabilityZones: cdk.Fn.getAzs(this.region),
    });
  }

  private resolveSubnet(config: OmniverseConfig, vpc: ec2.IVpc): ec2.ISubnet {
    if (config.createVpc) {
      const subnets = config.deploymentMode === 'public' ? vpc.publicSubnets : vpc.privateSubnets;
      // 신규 VPC: subnetIndex로 AZ 선택 (범위 넘으면 첫 번째).
      return subnets[config.subnetIndex] ?? subnets[0];
    }
    // 기존 VPC: subnetIndex로 선택된 (서브넷, AZ) 짝을 참조.
    const i = config.subnetIndex;
    return ec2.Subnet.fromSubnetAttributes(this, 'TargetSubnet', {
      subnetId: config.subnetIds[i],
      availabilityZone: config.availabilityZones[i],
    });
  }

  // ---------- SG 인바운드 규칙 (CLAUDE.md 섹션 3) ----------
  private addIngressRules(sg: ec2.SecurityGroup, config: OmniverseConfig): void {
    const rules: Array<{ port: ec2.Port; desc: string }> = [
      { port: ec2.Port.tcp(22), desc: 'SSH' },
      { port: ec2.Port.tcp(8443), desc: 'Amazon DCV' },
      { port: ec2.Port.tcp(80), desc: 'Web (launch-proxy)' },
      { port: ec2.Port.tcp(443), desc: 'Web (launch-proxy TLS)' },
      { port: ec2.Port.tcp(49100), desc: 'WebRTC signaling' },
      { port: ec2.Port.udp(1024), desc: 'WebRTC media' },
      { port: ec2.Port.tcpRange(47995, 48012), desc: 'WebRTC transport (tcp)' },
      { port: ec2.Port.udpRange(47995, 48012), desc: 'WebRTC transport (udp)' },
      { port: ec2.Port.tcpRange(49000, 49007), desc: 'WebRTC data (tcp)' },
      { port: ec2.Port.udpRange(49000, 49007), desc: 'WebRTC data (udp)' },
      // web-viewer-sample(vite dev server) — 브라우저 WebRTC 데모/테스트용 (README 5절)
      { port: ec2.Port.tcp(5173), desc: 'web-viewer-sample (vite, demo/test)' },
    ];
    if (config.installNim) {
      rules.push({ port: ec2.Port.tcp(config.nimPort), desc: 'NIM inference API' });
    }
    for (const cidr of config.allowedCidrs) {
      for (const r of rules) {
        sg.addIngressRule(ec2.Peer.ipv4(cidr), r.port, `${r.desc} from ${cidr}`);
      }
    }
  }

  // ---------- cdk-nag 예외 (사유 명시) ----------
  private addNagSuppressions(
    role: iam.Role,
    sg: ec2.SecurityGroup,
    createdSecrets: secretsmanager.Secret[],
  ): void {
    NagSuppressions.addResourceSuppressions(
      role,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'SSM/CloudWatch 관리형 정책은 운영 표준. 최소권한 범위 내.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'ecr:GetAuthorizationToken은 리소스 * 필수(토큰 발급). S3는 지정 버킷 ARN 한정.',
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(sg, [
      {
        id: 'AwsSolutions-EC23',
        reason:
          'allowedCidr로 소스 제한(0.0.0.0/0 금지 가드레일). WebRTC/DCV는 지정 대역만 허용.',
      },
    ]);
    // 시크릿 자동 rotation — PoC 단기 환경이라 미적용(DCV 비번/NGC 키는 수동 교체).
    // (CDK가 생성한 시크릿에만 적용. ngcSecretArn으로 가져온 기존 시크릿은 대상 아님.)
    if (createdSecrets.length > 0) {
      NagSuppressions.addResourceSuppressions(createdSecrets, [
        {
          id: 'AwsSolutions-SMG4',
          reason: 'PoC 단기 환경. DCV 비번은 부팅 주입, NGC 키는 수동 교체 → 자동 rotation 불요.',
        },
      ]);
    }
    // PoC 단일 인스턴스 — 종료 보호 미적용 (수동 stop/start 운영). 두 모드 공통.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-EC29',
        reason: 'PoC 단일 인스턴스(ASG 미사용). 종료 보호는 운영 전환 시 별도 적용.',
      },
    ]);
  }
}
