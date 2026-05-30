#!/usr/bin/env bash
# =============================================================================
# install-omniverse-host.sh — Omniverse 호스트 패키지 수동 설치 (옵션 / 폴백용)
# =============================================================================
# CDK UserData(lib/user-data.ts)와 동일한 패키지 스택을 EC2 안에서 손으로 설치하는
# 멱등(idempotent) 스크립트. 다음 상황을 위한 안전망:
#   - UserData가 일부 단계에서 실패했을 때 (DCV/Kit 라이브러리만 재설치 등)
#   - CDK 없이 EC2를 수동 기동한 경우
#   - 골든 AMI 만들기 전 단계별 검증
#
# 대상: Ubuntu 22.04 + NVIDIA 드라이버 사전설치(DL Base OSS Nvidia Driver GPU AMI).
# 반드시 root로 (sudo) 실행. 여러 번 돌려도 안전하도록 작성됨.
#
# 설치 계층 (CLAUDE.md 5-0):
#   ① GPU 드라이버 검증   ④ Kit 런타임 라이브러리   ⑤ Amazon DCV + Xorg
#   ② Docker + NVIDIA Container Toolkit (+ NIM)      ⑥ Python 3.12 (CAD/USD)
#
# 사용법:
#   sudo ./install-omniverse-host.sh [옵션]
#
#   --with-nim            Docker + NVIDIA Container Toolkit 설치 + NIM pull/run
#   --nim-image IMG       NIM 컨테이너 이미지 (기본: 아래 NIM_IMAGE)
#   --nim-port PORT       NIM 노출 포트 (기본: 8000)
#   --ngc-key KEY         NGC API Key (nvapi-...). 생략+--with-nim 시 프롬프트
#   --ngc-secret ARN      NGC 키를 Secrets Manager에서 조회 (--ngc-key 대신)
#   --dcv-password PW     DCV(ubuntu) 비밀번호. 생략 시 프롬프트(권장)
#   --dcv-secret ARN      DCV 비번을 Secrets Manager에서 조회 (--dcv-password 대신)
#   --with-python312      Python 3.12 (deadsnakes) 설치 — CAD 변환/USD 스크립팅용
#   --region REGION       Secrets Manager 조회 리전 (기본: ap-northeast-2)
#   --skip-dcv            DCV 설치 단계 건너뛰기
#   --skip-kit-libs       Kit 런타임 라이브러리 단계 건너뛰기
#   -h, --help            이 도움말
#
# 예:
#   sudo ./install-omniverse-host.sh                          # 드라이버+Kit libs+DCV만
#   sudo ./install-omniverse-host.sh --with-nim               # + NIM (프롬프트로 NGC 키)
#   sudo ./install-omniverse-host.sh --with-nim --ngc-secret arn:...:omniverse-ngc-api-key
#   sudo ./install-omniverse-host.sh --with-python312         # + Python 3.12
# =============================================================================
set -uo pipefail   # 주의: -e 제외 — apt 일시 실패로 전체가 죽지 않게(아래 재시도로 처리)

# --- 기본값 (lib/config.ts·cdk.json과 일치. ⚠️ NGC에 :latest 태그 없음 → 실제 태그 명시) ---
NIM_IMAGE="nvcr.io/nim/nvidia/domino-automotive-aero:2.1.0-41313772"
NIM_PORT="8000"
REGION="ap-northeast-2"
WITH_NIM=0
WITH_PY312=0
SKIP_DCV=0
SKIP_KIT_LIBS=0
NGC_KEY="" ; NGC_SECRET="" ; DCV_PW="" ; DCV_SECRET=""
LOG=/var/log/omniverse-install.log

# --- 옵션 파싱 ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-nim) WITH_NIM=1; shift ;;
    --nim-image) NIM_IMAGE="$2"; shift 2 ;;
    --nim-port) NIM_PORT="$2"; shift 2 ;;
    --ngc-key) NGC_KEY="$2"; shift 2 ;;
    --ngc-secret) NGC_SECRET="$2"; shift 2 ;;
    --dcv-password) DCV_PW="$2"; shift 2 ;;
    --dcv-secret) DCV_SECRET="$2"; shift 2 ;;
    --with-python312) WITH_PY312=1; shift ;;
    --region) REGION="$2"; shift 2 ;;
    --skip-dcv) SKIP_DCV=1; shift ;;
    --skip-kit-libs) SKIP_KIT_LIBS=1; shift ;;
    -h|--help) sed -n '2,52p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "오류: root로 실행하세요 (sudo $0 ...)" >&2; exit 1
fi

# 로그 이중 기록 (화면 + 파일)
exec > >(tee -a "$LOG") 2>&1
echo "[install] start $(date -u)"
export DEBIAN_FRONTEND=noninteractive

# --- apt 헬퍼 (락 대기 + 재시도) — UserData와 동일 전략 ---
wait_apt() {
  for i in $(seq 1 60); do
    if ! fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/lib/dpkg/lock >/dev/null 2>&1; then return 0; fi
    echo "[apt] lock held, waiting ($i)..."; sleep 10
  done; echo "[apt] WARN: lock 대기 타임아웃"; return 0
}
apt_do() { for i in 1 2 3 4 5; do wait_apt; if apt-get "$@"; then return 0; fi; echo "[apt] retry $i"; sleep 15; done; return 1; }

# Secrets Manager 헬퍼 (값이 JSON {"password":..} 형태면 추출, 평문이면 그대로)
fetch_secret() {  # $1=ARN  $2=jq키(옵션)
  local arn="$1" key="${2:-}"
  local raw; raw=$(aws secretsmanager get-secret-value --secret-id "$arn" \
    --query SecretString --output text --region "$REGION" 2>/dev/null) || { echo ""; return 1; }
  if [[ -n "$key" ]]; then echo "$raw" | jq -r ".${key} // ." ; else echo "$raw"; fi
}

# =============================================================================
# 계층① GPU 드라이버 검증
# =============================================================================
echo "[1/6] verify NVIDIA driver"
nvidia-smi || echo "WARN: nvidia-smi 실패 — 드라이버 확인 필요 (DLAMI가 아니면 nvidia-driver-580 설치 필요)"

# =============================================================================
# 계층④ Kit 런타임 라이브러리 (Vulkan/GL/X11 — Kit 미기동 주범)
# =============================================================================
if [[ "$SKIP_KIT_LIBS" -eq 0 ]]; then
  echo "[2/6] Kit 런타임 라이브러리 설치"
  apt_do update -y
  apt_do install -y \
    libvulkan1 vulkan-tools \
    libgl1-mesa-glx libgl1 libgles2 libegl1 libglx0 \
    libx11-6 libxext6 libxrandr2 libxcursor1 libxi6 libxinerama1 libxss1 \
    libgomp1 libglu1-mesa \
    fontconfig fonts-liberation \
    libasound2 libpulse0 libatomic1 \
    build-essential git git-lfs curl wget jq unzip \
    && echo "Kit libs OK" || echo "WARN: Kit 런타임 라이브러리 설치 일부 실패"
else
  echo "[2/6] --skip-kit-libs — Kit 라이브러리 단계 생략"
fi

mkdir -p /opt/nim/cache

# --- Vulkan/GL 검증 ---
echo "[3/6] verify Vulkan/GL"
ls /usr/share/vulkan/icd.d/nvidia_icd.json || echo "WARN: nvidia_icd.json 없음 (DCV 구성 후 재확인)"
vulkaninfo --summary || echo "WARN: vulkaninfo 실패 (X/DISPLAY 구성 후 재확인)"

# =============================================================================
# 계층② Docker + NVIDIA Container Toolkit + NIM (옵션)
# =============================================================================
if [[ "$WITH_NIM" -eq 1 ]]; then
  echo "[4/6] Docker + NVIDIA Container Toolkit + NIM"

  if ! command -v docker >/dev/null 2>&1; then
    apt_do install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
    apt_do update -y
    apt_do install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    echo "docker 이미 설치됨 — 스킵"
  fi

  # NVIDIA Container Toolkit (Docker 설치 완료에 의존 → 직렬)
  if [[ ! -f /etc/apt/sources.list.d/nvidia-container-toolkit.list ]]; then
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    apt_do update -y
  fi
  apt_do install -y nvidia-container-toolkit
  nvidia-ctk runtime configure --runtime=docker
  systemctl restart docker

  # NGC 키 확보: --ngc-key > --ngc-secret > 프롬프트
  if [[ -z "$NGC_KEY" && -n "$NGC_SECRET" ]]; then
    echo "NGC 키를 Secrets Manager에서 조회: $NGC_SECRET"
    NGC_KEY=$(fetch_secret "$NGC_SECRET") || echo "WARN: NGC 시크릿 조회 실패"
  fi
  if [[ -z "$NGC_KEY" ]]; then
    read -rsp "NGC API Key (nvapi-...): " NGC_KEY; echo
  fi

  if [[ -n "$NGC_KEY" ]]; then
    echo "$NGC_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin \
      || echo "WARN: nvcr.io 로그인 실패 — NGC 키 확인"
    docker pull "$NIM_IMAGE" || echo "WARN: NIM pull 실패 — early access/이미지·태그 확인"
    # NIM 모델 캐시: 컨테이너 비root 사용자가 써야 함 → 권한 개방 (Permission denied 방지)
    mkdir -p /opt/nim/cache && chmod -R 777 /opt/nim/cache
    # 기존 동명 컨테이너 정리 (재실행 멱등성)
    docker rm -f nim >/dev/null 2>&1 || true
    # ⚠️ NGC_API_KEY 환경변수 필수: 컨테이너가 시작 시 모델 가중치를 NGC에서 추가 다운로드
    docker run -d --restart unless-stopped --gpus all \
      -e NGC_API_KEY="$NGC_KEY" \
      -p "${NIM_PORT}:${NIM_PORT}" \
      -v /opt/nim/cache:/opt/nim/.cache \
      --name nim "$NIM_IMAGE" || echo "WARN: NIM 컨테이너 실행 실패"
  else
    echo "WARN: NGC 키 없음 — NIM pull/run 생략"
  fi
else
  echo "[4/6] --with-nim 미지정 — Docker/NIM 단계 생략"
fi

# =============================================================================
# 계층⑤ Amazon DCV + NVIDIA Xorg (헤드리스 GPU 렌더 → 원격 데스크톱)
# =============================================================================
if [[ "$SKIP_DCV" -eq 0 ]]; then
  echo "[5/6] Amazon DCV 설치"
  apt_do install -y ubuntu-desktop gdm3 mesa-utils xserver-xorg-video-dummy || true
  # NVIDIA Xorg 구성 (모니터 없이 GPU 바인딩)
  nvidia-xconfig --preserve-busid --enable-all-gpus || true

  if ! command -v dcv >/dev/null 2>&1; then
    # Amazon DCV 설치 (배포 시점 최신 URL/패키지명 확인 — nice-dcv→amazon-dcv 리브랜딩)
    cd /tmp
    wget -q "https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-ubuntu2204-x86_64.tgz" -O dcv.tgz \
      || echo "WARN: DCV 다운로드 실패 — URL 재확인"
    tar xzf dcv.tgz || true
    # server + gl + web-viewer(브라우저 접속 필수) + xdcv(가상 세션 X 서버)
    # ⚠️ web-viewer 누락 시 8443 접속 404 / xdcv 누락 시 가상 세션 미동작
    if cd nice-dcv-*-ubuntu2204-x86_64 2>/dev/null; then
      apt_do install -y ./nice-dcv-server_*.deb ./nice-dcv-gl_*.deb ./nice-dcv-web-viewer_*.deb ./nice-xdcv_*.deb || true
      cd /tmp
    else
      echo "WARN: DCV 패키지 디렉터리 없음 — 설치 스킵"
    fi
  else
    echo "dcv 이미 설치됨 — 스킵"
  fi

  # 자동 콘솔 세션 설정 (dcvserver 준비 후 세션 생성, 재부팅에도 유지)
  mkdir -p /etc/dcv
  sed -i 's/^#create-session = true/create-session = true/' /etc/dcv/dcv.conf 2>/dev/null || true
  grep -q '^create-session' /etc/dcv/dcv.conf 2>/dev/null || sed -i '/^\[session-management\]/a create-session = true' /etc/dcv/dcv.conf 2>/dev/null || true
  grep -q '^owner' /etc/dcv/dcv.conf 2>/dev/null || sed -i '/^\[session-management\/automatic-console-session\]/a owner = "ubuntu"' /etc/dcv/dcv.conf 2>/dev/null || true
  systemctl enable dcvserver || true
  systemctl restart dcvserver || true
  sleep 3
  # 폴백: 자동 콘솔 세션이 안 잡힌 경우 가상 세션 1회 생성
  dcv list-sessions 2>/dev/null | grep -q "console\|poc-session" || dcv create-session --type virtual --owner ubuntu poc-session || true

  # --- DCV 비밀번호 설정 ---
  if [[ -z "$DCV_PW" && -n "$DCV_SECRET" ]]; then
    DCV_PW=$(fetch_secret "$DCV_SECRET" password) || echo "WARN: DCV 시크릿 조회 실패"
  fi
  if [[ -z "$DCV_PW" ]]; then
    read -rsp "DCV(ubuntu) 비밀번호 (엔터=건너뛰기): " DCV_PW; echo
  fi
  if [[ -n "$DCV_PW" && "$DCV_PW" != "null" ]]; then
    echo "ubuntu:$DCV_PW" | chpasswd && echo "DCV 비밀번호 설정 완료"
  else
    echo "WARN: DCV 비밀번호 미설정 — 접속 전 'sudo passwd ubuntu' 필요"
  fi
else
  echo "[5/6] --skip-dcv — DCV 단계 생략"
fi

# =============================================================================
# 계층⑥ Python 3.12 (옵션) — CAD 변환(usd-convert-cad) / USD 스크립팅
# =============================================================================
if [[ "$WITH_PY312" -eq 1 ]]; then
  echo "[6/6] Python 3.12 (deadsnakes) 설치"
  apt_do install -y software-properties-common
  add-apt-repository -y ppa:deadsnakes/ppa
  apt_do update -y
  apt_do install -y python3.12 python3.12-venv python3.12-dev \
    && echo "Python 3.12 OK" || echo "WARN: Python 3.12 설치 실패"
else
  echo "[6/6] --with-python312 미지정 — Python 3.12 단계 생략"
fi

# =============================================================================
# 완료 + 진단 체크리스트 (CLAUDE.md 5-0)
# =============================================================================
echo
echo "===== 설치 완료 진단 ($(date -u)) ====="
echo "- nvidia-smi:    $(nvidia-smi >/dev/null 2>&1 && echo OK || echo FAIL)"
echo "- vulkan ICD:    $(ls /usr/share/vulkan/icd.d/nvidia_icd.json >/dev/null 2>&1 && echo OK || echo MISSING)"
echo "- docker:        $(command -v docker >/dev/null 2>&1 && echo OK || echo 'N/A (--with-nim 미사용)')"
echo "- dcvserver:     $(systemctl is-active dcvserver 2>/dev/null || echo inactive)"
echo "- python3.12:    $(command -v python3.12 >/dev/null 2>&1 && echo OK || echo 'N/A (--with-python312 미사용)')"
if [[ "$WITH_NIM" -eq 1 ]]; then
  echo "- NIM 컨테이너:  $(docker ps --filter name=nim --format '{{.Status}}' 2>/dev/null || echo 'not running')"
fi
echo
echo "다음 단계: DCV(8443)로 접속 후 kit-app-template 빌드 (CLAUDE.md 5-2)"
echo "  git clone https://github.com/NVIDIA-Omniverse/kit-app-template.git"
echo "  cd kit-app-template && ./repo.sh template new && ./repo.sh build && ./repo.sh launch"
echo "[install] done. 로그: $LOG"
touch /var/log/omniverse-install.done
