import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { OmniverseConfig } from './config';

export interface UserDataParams {
  config: OmniverseConfig;
  dcvSecretArn: string;
  ngcSecretArn: string;
  region: string;
  logGroupName: string;
}

/**
 * 부트스트랩 UserData 생성 (CLAUDE.md 섹션 5-0/5-1/11-1).
 * DLAMI(드라이버 사전설치) 기준. 단계:
 *  ① 드라이버 검증 → ④ Kit 런타임 라이브러리 → ⑤ DCV → ② Docker(+NIM) 병렬,
 *  완료 시 cfn-signal. 오래 걸리는 NIM pull은 초반 백그라운드.
 */
export function buildUserData(params: UserDataParams): ec2.UserData {
  const { config, dcvSecretArn, ngcSecretArn, region, logGroupName } = params;
  const ud = ec2.UserData.forLinux();

  ud.addCommands(
    'set -uxo pipefail', // 주의: -e 제외 — apt 일시적 실패로 부트스트랩 전체가 죽지 않게(아래 재시도로 처리)
    'exec > >(tee -a /var/log/omniverse-bootstrap.log) 2>&1',
    'echo "[bootstrap] start $(date -u)"',
    'export DEBIAN_FRONTEND=noninteractive',

    // DLAMI는 부팅 직후 자체 apt 작업을 돌림 → 락 대기 헬퍼 (경합 방지, 흔한 함정).
    'wait_apt() {',
    '  for i in $(seq 1 60); do',
    '    if ! fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/lib/dpkg/lock >/dev/null 2>&1; then return 0; fi',
    '    echo "[apt] lock held, waiting ($i)..."; sleep 10;',
    '  done; echo "[apt] WARN: lock 대기 타임아웃"; return 0',
    '}',
    // apt 작업 재시도 래퍼 (네트워크/미러 일시 오류 흡수).
    'apt_do() { for i in 1 2 3 4 5; do wait_apt; if apt-get "$@"; then return 0; fi; echo "[apt] retry $i"; sleep 15; done; return 1; }',

    // --- 계층① GPU 드라이버 검증 (DLAMI 사전설치) ---
    'echo "[1/8] verify NVIDIA driver"',
    'nvidia-smi || echo "WARN: nvidia-smi 실패 — 드라이버 확인 필요"',

    // --- (installNim 시) NIM 이미지 pull을 가장 먼저 백그라운드로 시작 ---
    ...(config.installNim
      ? [
          'echo "[2/8] (bg) docker + NIM pull 시작"',
          nimBackgroundBlock(config, ngcSecretArn, region),
        ]
      : ['echo "[2/8] installNim=false — NIM 단계 생략"']),

    // --- 계층④ Kit 런타임 라이브러리 (apt, 백그라운드) ---
    'echo "[3/8] (bg) Kit 런타임 라이브러리 설치"',
    'install_kit_libs() {',
    '  apt_do update -y',
    '  apt_do install -y \\',
    '    libvulkan1 vulkan-tools \\',
    '    libgl1-mesa-glx libgl1 libgles2 libegl1 libglx0 \\',
    '    libx11-6 libxext6 libxrandr2 libxcursor1 libxi6 libxinerama1 libxss1 \\',
    '    libgomp1 libglu1-mesa \\',
    '    fontconfig fonts-liberation \\',
    '    libasound2 libpulse0 libatomic1 \\',
    '    build-essential git git-lfs curl wget jq unzip',
    '}',
    'install_kit_libs & KIT_LIBS_PID=$!',

    // --- 데이터/캐시 디렉터리 (루트 볼륨 내) ---
    'mkdir -p /opt/nim/cache',

    // --- 병렬 작업 완료 대기 ---
    'echo "[4/8] wait background installs"',
    'wait "$KIT_LIBS_PID" && echo "Kit libs OK" || echo "WARN: Kit 런타임 라이브러리 설치 일부 실패 — DCV 접속 후 점검"',

    // --- Vulkan/GL 검증 (계층④ 확인) ---
    'echo "[5/8] verify Vulkan/GL"',
    'ls /usr/share/vulkan/icd.d/nvidia_icd.json || echo "WARN: nvidia_icd.json 없음 (DCV 구성 후 재확인)"',
    'vulkaninfo --summary || echo "WARN: vulkaninfo 실패 (X/DISPLAY 구성 후 재확인)"',

    // --- 계층⑤ Amazon DCV + Xorg ---
    'echo "[6/8] install Amazon DCV"',
    dcvInstallBlock(),

    // --- (옵션) 사내 CA DCV TLS 인증서 주입 → 미지정 시 DCV self-signed ---
    ...(config.dcvCertSecretArn
      ? [
          'echo "[6b/8] install custom DCV TLS cert"',
          dcvCertBlock(config.dcvCertSecretArn, region),
        ]
      : ['echo "[6b/8] no custom cert — DCV self-signed 사용(브라우저 경고 정상)"']),

    // --- DCV 비밀번호 주입 (Secrets Manager) ---
    'echo "[7/8] set DCV password from Secrets Manager"',
    setDcvPasswordBlock(dcvSecretArn, region),

    // --- code-server (옵션) ---
    ...(config.installCodeServer
      ? ['echo "[opt] install code-server"', 'curl -fsSL https://code-server.dev/install.sh | sh || true']
      : []),

    // --- 백그라운드 NIM 설치 완료 대기 (installNim 시) ---
    ...(config.installNim
      ? ['echo "[7b/8] wait NIM install"', 'wait "$NIM_PID" && echo "NIM OK" || echo "WARN: NIM 설치 미완료 — 로그 확인"']
      : []),

    // --- 부트스트랩 로그를 CloudWatch로 전송 (SSH 없이 진행 확인) ---
    'echo "[8/8] ship bootstrap log to CloudWatch"',
    cloudWatchLogBlock(logGroupName, region),

    'echo "[done] bootstrap finished $(date -u)"',
    'touch /var/log/omniverse-bootstrap.done',
  );

  return ud;
}

/** CloudWatch agent 설치 후 부트스트랩 로그를 지정 로그그룹으로 전송. */
function cloudWatchLogBlock(logGroupName: string, region: string): string {
  return [
    'CWA_DEB=/tmp/amazon-cloudwatch-agent.deb',
    `wget -q "https://amazoncloudwatch-agent-${region}.s3.${region}.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb" -O "$CWA_DEB" || echo "WARN: CW agent 다운로드 실패"`,
    'dpkg -i -E "$CWA_DEB" || true',
    'cat > /opt/aws/amazon-cloudwatch-agent/etc/cw-bootstrap.json <<JSON',
    JSON.stringify({
      logs: {
        logs_collected: {
          files: {
            collect_list: [
              {
                file_path: '/var/log/omniverse-bootstrap.log',
                log_group_name: logGroupName,
                log_stream_name: '{instance_id}/bootstrap',
              },
            ],
          },
        },
      },
    }),
    'JSON',
    '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/cw-bootstrap.json || echo "WARN: CW agent 설정 실패"',
  ].join('\n');
}

/** 계층② Docker + NVIDIA Container Toolkit 설치 후 nvcr.io 로그인 → NIM pull/run (백그라운드 함수). */
function nimBackgroundBlock(config: OmniverseConfig, ngcSecretArn: string, region: string): string {
  return [
    'install_and_run_nim() {',
    '  # Docker CE',
    '  apt_do install -y ca-certificates curl gnupg',
    '  install -m 0755 -d /etc/apt/keyrings',
    '  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg',
    '  chmod a+r /etc/apt/keyrings/docker.gpg',
    '  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list',
    '  apt_do update -y',
    '  apt_do install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
    '  # NVIDIA Container Toolkit (Docker 설치 완료에 의존 → 직렬)',
    '  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg',
    '  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" > /etc/apt/sources.list.d/nvidia-container-toolkit.list',
    '  apt_do update -y',
    '  apt_do install -y nvidia-container-toolkit',
    '  nvidia-ctk runtime configure --runtime=docker',
    '  systemctl restart docker',
    '  # NGC 로그인 (Secrets Manager에서 API Key 조회)',
    `  NGC_KEY=$(aws secretsmanager get-secret-value --secret-id ${ngcSecretArn} --query SecretString --output text --region ${region})`,
    '  echo "$NGC_KEY" | docker login nvcr.io --username \'$oauthtoken\' --password-stdin || echo "WARN: nvcr.io 로그인 실패 — NGC 키 확인"',
    `  docker pull ${config.nimImage} || echo "WARN: NIM pull 실패 — early access/이미지·태그 확인(:latest 없음)"`,
    '  # NIM 모델 캐시: 컨테이너 비root 사용자가 써야 함 → 권한 개방 (Permission denied 방지)',
    '  mkdir -p /opt/nim/cache && chmod -R 777 /opt/nim/cache',
    '  # ⚠️ NGC_API_KEY 환경변수 필수: 컨테이너가 시작 시 모델 가중치를 NGC에서 추가 다운로드',
    '  #    (docker login은 이미지 pull용일 뿐, 런타임 모델 다운로드엔 이 env가 따로 필요)',
    `  docker run -d --restart unless-stopped --gpus all \\`,
    '    -e NGC_API_KEY="$NGC_KEY" \\',
    `    -p ${config.nimPort}:${config.nimPort} \\`,
    '    -v /opt/nim/cache:/opt/nim/.cache \\',
    `    --name nim ${config.nimImage} || echo "WARN: NIM 컨테이너 실행 실패"`,
    '}',
    'install_and_run_nim & NIM_PID=$!',
  ].join('\n');
}

/** Amazon DCV 서버 + dcv-gl 설치, NVIDIA Xorg 구성, 가상 세션 (Ubuntu 22.04). */
function dcvInstallBlock(): string {
  return [
    'apt_do install -y ubuntu-desktop gdm3 mesa-utils xserver-xorg-video-dummy || true',
    '# NVIDIA Xorg 구성 (모니터 없이 GPU 바인딩)',
    'nvidia-xconfig --preserve-busid --enable-all-gpus || true',
    '# Amazon DCV 설치 (배포 시점 최신 URL/패키지명 확인 필요 — nice-dcv→amazon-dcv 리브랜딩)',
    'cd /tmp',
    'wget -q "https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-ubuntu2204-x86_64.tgz" -O dcv.tgz || echo "WARN: DCV 다운로드 실패 — URL 재확인"',
    'tar xzf dcv.tgz || true',
    // nice-dcv-server + gl + web-viewer(브라우저 접속 필수) + xdcv(가상 세션 X 서버).
    // ⚠️ web-viewer 누락 시 8443 접속이 404 → 브라우저 접속 불가. xdcv 누락 시 가상 세션 미동작.
    'cd nice-dcv-*-ubuntu2204-x86_64 2>/dev/null && { apt_do install -y ./nice-dcv-server_*.deb ./nice-dcv-gl_*.deb ./nice-dcv-web-viewer_*.deb ./nice-xdcv_*.deb || true; cd /tmp; } || echo "WARN: DCV 패키지 설치 스킵"',
    // 자동 콘솔 세션: 부팅 시 dcv create-session을 직접 호출하면 X 준비 전이라 휘발됨.
    // → dcv.conf에 자동 세션 생성을 설정해 dcvserver가 준비 완료 후 세션을 만들게 한다(재부팅에도 유지).
    'mkdir -p /etc/dcv',
    "sed -i 's/^#create-session = true/create-session = true/' /etc/dcv/dcv.conf 2>/dev/null || true",
    "grep -q '^create-session' /etc/dcv/dcv.conf || sed -i '/^\\[session-management\\]/a create-session = true' /etc/dcv/dcv.conf",
    "grep -q '^owner' /etc/dcv/dcv.conf || sed -i '/^\\[session-management\\/automatic-console-session\\]/a owner = \"ubuntu\"' /etc/dcv/dcv.conf",
    'systemctl enable dcvserver || true',
    'systemctl restart dcvserver || true',
    'sleep 3',
    '# 자동 콘솔 세션이 안 잡힌 경우 폴백으로 가상 세션 1회 생성',
    'dcv list-sessions 2>/dev/null | grep -q "console\\|poc-session" || dcv create-session --type virtual --owner ubuntu poc-session || true',
  ].join('\n');
}

/**
 * (옵션) 사내 CA DCV TLS 인증서 주입.
 * 시크릿 JSON {"cert":"<PEM>","key":"<PEM>"} → DCV 인증서 경로에 배치 후 dcvserver 재시작.
 * 미설치 시 DCV가 자동 생성한 self-signed 인증서가 그대로 유지됨.
 */
function dcvCertBlock(certSecretArn: string, region: string): string {
  return [
    `DCV_CERT_JSON=$(aws secretsmanager get-secret-value --secret-id ${certSecretArn} --query SecretString --output text --region ${region})`,
    'if [ -n "$DCV_CERT_JSON" ]; then',
    '  echo "$DCV_CERT_JSON" | jq -r \'.cert\' > /etc/dcv/dcv.pem',
    '  echo "$DCV_CERT_JSON" | jq -r \'.key\'  > /etc/dcv/dcv.key',
    '  chown dcv:dcv /etc/dcv/dcv.pem /etc/dcv/dcv.key 2>/dev/null || true',
    '  chmod 600 /etc/dcv/dcv.key; chmod 644 /etc/dcv/dcv.pem',
    '  systemctl restart dcvserver || true',
    '  echo "custom DCV cert installed"',
    'else',
    '  echo "WARN: DCV 인증서 시크릿 비어있음 — self-signed 유지"',
    'fi',
  ].join('\n');
}

/** Secrets Manager에서 DCV 비밀번호 조회 → ubuntu 사용자 비밀번호 설정. */
function setDcvPasswordBlock(dcvSecretArn: string, region: string): string {
  return [
    `DCV_PW=$(aws secretsmanager get-secret-value --secret-id ${dcvSecretArn} --query SecretString --output text --region ${region} | jq -r '.password // .')`,
    'if [ -n "$DCV_PW" ] && [ "$DCV_PW" != "null" ]; then',
    '  echo "ubuntu:$DCV_PW" | chpasswd',
    'else',
    '  echo "WARN: DCV 비밀번호 조회 실패"',
    'fi',
  ].join('\n');
}
