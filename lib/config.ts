import * as cdk from 'aws-cdk-lib';

/** 허용 인스턴스 타입 (CLAUDE.md 섹션 2). 이 4종 외 입력은 합성 단계에서 차단. */
export const ALLOWED_INSTANCE_TYPES = [
  'g7e.4xlarge', // 기본 — RTX PRO 6000 96GB ×1, 단일 GPU 풀스택
  'g7e.12xlarge', // RTX PRO 6000 ×2
  'g6e.4xlarge', // L40S 48GB ×1
  'g6e.12xlarge', // L40S ×4
] as const;
export type AllowedInstanceType = (typeof ALLOWED_INSTANCE_TYPES)[number];

export type DeploymentMode = 'private' | 'public';

export interface OmniverseConfig {
  deploymentMode: DeploymentMode;
  instanceType: AllowedInstanceType;
  /** 콤마 구분 가능. 0.0.0.0/0 금지. */
  allowedCidrs: string[];
  /** private 필수 / public(기존 VPC 사용 시) 필수. createVpc=true면 미사용. */
  vpcId?: string;
  /** 기존 서브넷 ID 목록 (콤마 다중 입력, 서울 2a/2b 등). subnetIds[i] ↔ availabilityZones[i] 짝. */
  subnetIds: string[];
  /** subnetIds와 같은 순서의 AZ 목록 (예: ap-northeast-2a,ap-northeast-2b). */
  availabilityZones: string[];
  /** 이번 배포에 사용할 서브넷 인덱스 (capacity 막히면 인덱스만 바꿔 재배포). 기본 0. */
  subnetIndex: number;
  /** public + 신규 VPC 생성 옵션. */
  createVpc: boolean;
  keyPairName?: string;
  assetBucketName?: string;
  installNim: boolean;
  /**
   * (옵션) 미리 NGC API Key를 담아 만든 Secrets Manager 시크릿 ARN.
   * 지정 시 CDK가 새 시크릿을 만들지 않고 이 시크릿을 사용 → 부팅 중 NIM pull 즉시 성공.
   * 미지정 시 CDK가 플레이스홀더 시크릿을 생성(배포 후 수동으로 키 주입 필요).
   */
  ngcSecretArn?: string;
  nimImage: string;
  nimPort: number;
  rootVolumeSizeGb: number;
  retainDataOnDelete: boolean;
  installCodeServer: boolean;
  /**
   * (옵션) 사내 CA가 발급한 DCV TLS 인증서를 담은 Secrets Manager 시크릿 ARN.
   * 시크릿은 JSON {"cert":"<PEM>","key":"<PEM>"} 형식. 미지정 시 DCV self-signed 사용.
   */
  dcvCertSecretArn?: string;
  projectTag: string;
  ownerTag?: string;
}

function ctx(app: cdk.App, key: string): string | undefined {
  const v = app.node.tryGetContext(key);
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length === 0 ? undefined : s;
}

function ctxBool(app: cdk.App, key: string, fallback: boolean): boolean {
  const v = app.node.tryGetContext(key);
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  return v === true || String(v).toLowerCase() === 'true';
}

function ctxNum(app: cdk.App, key: string, fallback: number): number {
  const s = ctx(app, key);
  if (s === undefined) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`잘못된 숫자 파라미터 ${key}=${s}`);
  return n;
}

/** CIDR 형식 + 0.0.0.0/0 금지 가드레일 (CLAUDE.md 섹션 3). */
function validateCidr(cidr: string): void {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) {
    throw new Error(`allowedCidr 형식 오류: "${cidr}" (예: 10.1.0.0/16 또는 x.x.x.x/32)`);
  }
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) {
    throw new Error(`allowedCidr 범위 오류: "${cidr}"`);
  }
  // 가장 중요한 가드레일: 전체 개방 금지 (DCV 인터넷 노출 사고 방지).
  if (cidr === '0.0.0.0/0' || prefix === 0) {
    throw new Error(
      `allowedCidr=0.0.0.0/0 금지. 사내망 대역(private) 또는 접속자 IP/32(public)를 지정하세요.`,
    );
  }
}

export function parseConfig(app: cdk.App): OmniverseConfig {
  const deploymentMode = (ctx(app, 'deploymentMode') ?? 'private') as DeploymentMode;
  if (deploymentMode !== 'private' && deploymentMode !== 'public') {
    throw new Error(`deploymentMode는 private|public 만 허용 (입력: ${deploymentMode})`);
  }

  const instanceType = (ctx(app, 'instanceType') ?? 'g7e.4xlarge') as AllowedInstanceType;
  if (!ALLOWED_INSTANCE_TYPES.includes(instanceType)) {
    throw new Error(
      `instanceType "${instanceType}" 미허용. 허용: ${ALLOWED_INSTANCE_TYPES.join(', ')}`,
    );
  }

  const allowedCidrRaw = ctx(app, 'allowedCidr');
  if (!allowedCidrRaw) {
    throw new Error(
      `allowedCidr 필수. 예) -c allowedCidr=10.1.0.0/16 (private) 또는 x.x.x.x/32 (public)`,
    );
  }
  const allowedCidrs = allowedCidrRaw.split(',').map((c) => c.trim()).filter(Boolean);
  allowedCidrs.forEach(validateCidr);

  const createVpc = ctxBool(app, 'createVpc', false);
  const vpcId = ctx(app, 'vpcId');
  // 다중 서브넷/AZ — 콤마 구분. subnetIds[i] ↔ availabilityZones[i] 짝.
  const subnetIds = (ctx(app, 'subnetIds') ?? ctx(app, 'subnetId') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const availabilityZones = (ctx(app, 'availabilityZones') ?? ctx(app, 'availabilityZone') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // 모드별 필수 입력 검증.
  if (createVpc) {
    if (deploymentMode === 'private') {
      throw new Error('private 모드는 createVpc 불가. 기존 VPC(vpcId/subnetIds) 사용.');
    }
    // public + createVpc: 신규 VPC가 서브넷/AZ를 제공하므로 입력 불요.
  } else {
    if (!vpcId) {
      throw new Error(`${deploymentMode} 모드는 vpcId 필수 (기존 VPC).`);
    }
    if (subnetIds.length === 0) {
      throw new Error(
        'subnetIds 필수. 콤마로 다중 입력 가능 (예: -c subnetIds=subnet-aaa,subnet-bbb).',
      );
    }
    if (availabilityZones.length !== subnetIds.length) {
      throw new Error(
        `availabilityZones 개수(${availabilityZones.length})가 subnetIds 개수(${subnetIds.length})와 ` +
          `일치해야 합니다 (같은 순서로 짝). 예: -c availabilityZones=ap-northeast-2a,ap-northeast-2b`,
      );
    }
  }

  // 이번 배포에 사용할 서브넷 인덱스 (capacity 폴백 시 인덱스만 변경).
  const subnetIndex = ctxNum(app, 'subnetIndex', 0);
  if (!createVpc && (subnetIndex < 0 || subnetIndex >= subnetIds.length)) {
    throw new Error(
      `subnetIndex=${subnetIndex} 범위 초과 (subnetIds 0..${subnetIds.length - 1}).`,
    );
  }

  const rootVolumeSizeGb = ctxNum(app, 'rootVolumeSizeGb', 500);
  if (rootVolumeSizeGb < 100) {
    throw new Error(`rootVolumeSizeGb는 100 이상 권장 (입력: ${rootVolumeSizeGb})`);
  }

  return {
    deploymentMode,
    instanceType,
    allowedCidrs,
    vpcId,
    subnetIds,
    availabilityZones,
    subnetIndex,
    createVpc,
    keyPairName: ctx(app, 'keyPairName'),
    assetBucketName: ctx(app, 'assetBucketName'),
    installNim: ctxBool(app, 'installNim', false),
    ngcSecretArn: ctx(app, 'ngcSecretArn'),
    // 주의: NGC에 'latest' 태그 없음. 실제 태그(1.0.0 / 2.0.0 / 2.1.0-...)를 명시해야 함.
    nimImage: ctx(app, 'nimImage') ?? 'nvcr.io/nim/nvidia/domino-automotive-aero:2.1.0-41313772',
    nimPort: ctxNum(app, 'nimPort', 8000),
    rootVolumeSizeGb,
    retainDataOnDelete: ctxBool(app, 'retainDataOnDelete', false),
    installCodeServer: ctxBool(app, 'installCodeServer', false),
    dcvCertSecretArn: ctx(app, 'dcvCertSecretArn'),
    projectTag: ctx(app, 'projectTag') ?? 'omniverse-poc',
    ownerTag: ctx(app, 'ownerTag'),
  };
}
