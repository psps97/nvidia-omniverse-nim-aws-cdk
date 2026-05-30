#!/usr/bin/env bash
# =============================================================================
# install-nim.sh — NVIDIA NIM 컨테이너 전용 설치/실행 스크립트 (옵션)
# =============================================================================
# Docker + NVIDIA Container Toolkit 설치(필요 시) → nvcr.io 로그인 → NIM pull → run
# → 헬스체크까지 NIM 한 가지만 다루는 멱등 스크립트.
# install-omniverse-host.sh --with-nim 의 NIM 부분만 떼어낸 것으로, 다음에 유용:
#   - 모델만 교체/업그레이드 (--nim-image 바꿔 재실행)
#   - NIM 컨테이너만 재시작/재설치 (Kit·DCV는 그대로)
#   - 멀티 GPU에서 특정 GPU에만 NIM 배치 (--gpu-device)
#
# 대상: Ubuntu 22.04 + NVIDIA 드라이버 사전설치. root(sudo)로 실행.
#
# 사용법:
#   sudo ./install-nim.sh [옵션]
#
#   --nim-image IMG     NIM 컨테이너 이미지 (기본: 아래 NIM_IMAGE)
#   --nim-port PORT     노출 포트 (기본: 8000)
#   --ngc-key KEY       NGC API Key (nvapi-...). 생략 시 프롬프트(숨김)
#   --ngc-secret ARN    NGC 키를 Secrets Manager에서 조회 (--ngc-key 대신)
#   --region REGION     Secrets Manager 조회 리전 (기본: ap-northeast-2)
#   --gpu-device N      특정 GPU에만 배치 (멀티 GPU 분리, 예: 1). 기본: all
#   --cache-dir DIR     모델 캐시 호스트 경로 (기본: /opt/nim/cache)
#   --name NAME         컨테이너 이름 (기본: nim)
#   --no-run            pull까지만, 컨테이너 실행 안 함
#   --skip-docker       Docker/Container Toolkit 설치 건너뛰기 (이미 있을 때)
#   -h, --help          이 도움말
#
# 예:
#   sudo ./install-nim.sh                                  # 기본 모델 pull+run (NGC 키 프롬프트)
#   sudo ./install-nim.sh --ngc-secret arn:...:omniverse-ngc-api-key
#   sudo ./install-nim.sh --nim-image nvcr.io/nim/nvidia/usdcode:1.0.0 --nim-port 8001
#   sudo ./install-nim.sh --gpu-device 1                   # GPU 1에만 (g7e.12xlarge 등)
# =============================================================================
set -uo pipefail   # 주의: -e 제외 — apt 일시 실패로 전체가 죽지 않게(아래 재시도로 처리)

# --- 기본값 (lib/config.ts·cdk.json과 일치. ⚠️ NGC에 :latest 태그 없음 → 실제 태그 명시) ---
NIM_IMAGE="nvcr.io/nim/nvidia/domino-automotive-aero:2.1.0-41313772"
NIM_PORT="8000"
REGION="ap-northeast-2"
GPU_DEVICE="all"
CACHE_DIR="/opt/nim/cache"
NAME="nim"
NO_RUN=0
SKIP_DOCKER=0
NGC_KEY="" ; NGC_SECRET=""
LOG=/var/log/nim-install.log

# --- 옵션 파싱 ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --nim-image) NIM_IMAGE="$2"; shift 2 ;;
    --nim-port) NIM_PORT="$2"; shift 2 ;;
    --ngc-key) NGC_KEY="$2"; shift 2 ;;
    --ngc-secret) NGC_SECRET="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --gpu-device) GPU_DEVICE="$2"; shift 2 ;;
    --cache-dir) CACHE_DIR="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --no-run) NO_RUN=1; shift ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "오류: root로 실행하세요 (sudo $0 ...)" >&2; exit 1
fi

exec > >(tee -a "$LOG") 2>&1
echo "[nim] start $(date -u) — image=$NIM_IMAGE port=$NIM_PORT gpu=$GPU_DEVICE"
export DEBIAN_FRONTEND=noninteractive

# --- apt 헬퍼 (락 대기 + 재시도) — UserData와 동일 전략 ---
wait_apt() {
  for i in $(seq 1 60); do
    if ! fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/lib/dpkg/lock >/dev/null 2>&1; then return 0; fi
    echo "[apt] lock held, waiting ($i)..."; sleep 10
  done; echo "[apt] WARN: lock 대기 타임아웃"; return 0
}
apt_do() { for i in 1 2 3 4 5; do wait_apt; if apt-get "$@"; then return 0; fi; echo "[apt] retry $i"; sleep 15; done; return 1; }

# =============================================================================
# ① GPU 드라이버 검증 (NIM은 CUDA만 쓰므로 드라이버 + 컨테이너 런타임이면 충분)
# =============================================================================
echo "[1/5] verify NVIDIA driver"
nvidia-smi || { echo "오류: nvidia-smi 실패 — GPU 드라이버 없이는 NIM 불가" >&2; exit 1; }

# =============================================================================
# ② Docker + NVIDIA Container Toolkit
# =============================================================================
if [[ "$SKIP_DOCKER" -eq 0 ]]; then
  echo "[2/5] Docker + NVIDIA Container Toolkit"
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
else
  echo "[2/5] --skip-docker — Docker/Toolkit 설치 생략"
fi

# =============================================================================
# ③ NGC 로그인 (키: --ngc-key > --ngc-secret > 프롬프트)
# =============================================================================
echo "[3/5] nvcr.io 로그인"
if [[ -z "$NGC_KEY" && -n "$NGC_SECRET" ]]; then
  echo "NGC 키를 Secrets Manager에서 조회: $NGC_SECRET"
  NGC_KEY=$(aws secretsmanager get-secret-value --secret-id "$NGC_SECRET" \
    --query SecretString --output text --region "$REGION" 2>/dev/null) || echo "WARN: NGC 시크릿 조회 실패"
fi
if [[ -z "$NGC_KEY" ]]; then
  read -rsp "NGC API Key (nvapi-...): " NGC_KEY; echo
fi
if [[ -z "$NGC_KEY" ]]; then
  echo "오류: NGC API Key가 없습니다." >&2; exit 1
fi
if [[ "$NGC_KEY" != nvapi-* ]]; then
  echo "경고: 키가 'nvapi-'로 시작하지 않습니다 — 올바른 NGC Personal Key인지 확인하세요." >&2
fi
echo "$NGC_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin \
  || { echo "오류: nvcr.io 로그인 실패 — NGC 키 확인" >&2; exit 1; }

# =============================================================================
# ④ NIM pull + run
# =============================================================================
echo "[4/5] NIM pull: $NIM_IMAGE"
docker pull "$NIM_IMAGE" || { echo "오류: NIM pull 실패 — early access/이미지·태그 확인(:latest 없음)" >&2; exit 1; }

if [[ "$NO_RUN" -eq 1 ]]; then
  echo "[4/5] --no-run — pull까지만 완료, 컨테이너 실행 생략"
else
  # NIM 모델 캐시: 컨테이너 비root 사용자가 써야 함 → 권한 개방 (Permission denied 방지)
  mkdir -p "$CACHE_DIR" && chmod -R 777 "$CACHE_DIR"
  # 기존 동명 컨테이너 정리 (재실행 멱등성)
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # GPU 지정: all(기본) 또는 특정 device (멀티 GPU 분리). 배열로 전달해 따옴표 리터럴 문제 회피.
  if [[ "$GPU_DEVICE" == "all" ]]; then GPU_ARG=(--gpus all); else GPU_ARG=(--gpus "device=${GPU_DEVICE}"); fi
  # ⚠️ NGC_API_KEY 환경변수 필수: 컨테이너가 시작 시 모델 가중치를 NGC에서 추가 다운로드
  #    (docker login은 이미지 pull용일 뿐, 런타임 모델 다운로드엔 이 env가 따로 필요)
  docker run -d --restart unless-stopped "${GPU_ARG[@]}" \
    -e NGC_API_KEY="$NGC_KEY" \
    -p "${NIM_PORT}:${NIM_PORT}" \
    -v "${CACHE_DIR}:/opt/nim/.cache" \
    --name "$NAME" "$NIM_IMAGE" || { echo "오류: NIM 컨테이너 실행 실패" >&2; exit 1; }
fi

# =============================================================================
# ⑤ 헬스체크 (모델 가중치 다운로드/로딩에 수 분 걸릴 수 있음)
# =============================================================================
if [[ "$NO_RUN" -eq 0 ]]; then
  echo "[5/5] 헬스체크 — 모델 READY까지 대기 (최대 ~10분, 최초 실행은 가중치 다운로드)"
  READY=0
  for i in $(seq 1 60); do
    if curl -fsk "http://localhost:${NIM_PORT}/v1/health/ready" >/dev/null 2>&1; then
      READY=1; break
    fi
    # 컨테이너가 죽었으면 즉시 중단
    if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]]; then
      echo "오류: NIM 컨테이너가 종료됨 → docker logs $NAME 확인" >&2
      docker logs --tail 30 "$NAME" 2>/dev/null || true
      exit 1
    fi
    echo "  ...not ready ($i/60), 10s 대기"; sleep 10
  done
  if [[ "$READY" -eq 1 ]]; then
    echo "✅ NIM READY — http://localhost:${NIM_PORT}"
    curl -sk "http://localhost:${NIM_PORT}/v1/metadata" 2>/dev/null | head -c 400; echo
  else
    echo "WARN: 헬스체크 타임아웃 — 가중치 다운로드가 길 수 있음. 'docker logs -f $NAME'로 진행 확인"
  fi
else
  echo "[5/5] --no-run — 헬스체크 생략"
fi

echo
echo "===== 요약 ($(date -u)) ====="
echo "- 이미지:     $NIM_IMAGE"
echo "- 컨테이너:   $(docker ps --filter name="^${NAME}$" --format '{{.Status}}' 2>/dev/null || echo 'not running')"
echo "- 엔드포인트: http://localhost:${NIM_PORT}  (health: /v1/health/ready)"
echo "- 로그:       docker logs -f $NAME   |   설치 로그: $LOG"
echo "[nim] done."
touch /var/log/nim-install.done
