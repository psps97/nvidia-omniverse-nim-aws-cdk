#!/usr/bin/env bash
# =============================================================================
# create-ngc-secret.sh — NGC API Key를 AWS Secrets Manager에 미리 생성
# =============================================================================
# 배포 전 사전 체크 단계에서 NGC 키 시크릿을 만들어 두고, 그 ARN을
# `cdk deploy -c ngcSecretArn=<ARN>` 로 넘기면 부팅 중 NIM pull이 즉시 성공한다.
# (미지정 시 CDK가 플레이스홀더 시크릿을 만들고, 배포 후 수동으로 키를 넣어야 함)
#
# 사용법:
#   ./scripts/create-ngc-secret.sh [-n NAME] [-r REGION] [-p PROFILE] [KEY]
#
#   KEY        NGC API Key (nvapi-...). 생략 시 프롬프트로 숨김 입력받음(권장).
#   -n NAME    시크릿 이름 (기본: omniverse-ngc-api-key)
#   -r REGION  리전 (기본: ap-northeast-2)
#   -p PROFILE AWS 프로파일 (기본: 환경 그대로)
#
# 예:
#   ./scripts/create-ngc-secret.sh                       # 프롬프트로 키 입력(가장 안전)
#   ./scripts/create-ngc-secret.sh -p mfg-idp            # 프로파일 지정 + 프롬프트
#   ./scripts/create-ngc-secret.sh nvapi-xxxxx           # 인자로 키 전달(히스토리 주의)
#
# 출력: 생성/갱신된 시크릿 ARN (그대로 cdk -c ngcSecretArn= 에 사용)
# =============================================================================
set -euo pipefail

NAME="omniverse-ngc-api-key"
REGION="ap-northeast-2"
PROFILE_ARG=()

while getopts ":n:r:p:h" opt; do
  case "$opt" in
    n) NAME="$OPTARG" ;;
    r) REGION="$OPTARG" ;;
    p) PROFILE_ARG=(--profile "$OPTARG") ;;
    h) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: -$OPTARG" >&2; exit 1 ;;
  esac
done
shift $((OPTIND - 1))

KEY="${1:-}"
if [[ -z "$KEY" ]]; then
  # 프롬프트 숨김 입력 (히스토리/로그에 안 남김 — 권장)
  read -rsp "NGC API Key (nvapi-...): " KEY
  echo
fi

if [[ -z "$KEY" ]]; then
  echo "오류: NGC API Key가 비었습니다." >&2
  exit 1
fi
if [[ "$KEY" != nvapi-* ]]; then
  echo "경고: 키가 'nvapi-'로 시작하지 않습니다. 올바른 NGC Personal Key인지 확인하세요." >&2
fi

echo "리전: $REGION / 시크릿 이름: $NAME" >&2

# 이미 존재하면 값만 갱신(put), 없으면 생성(create).
if aws secretsmanager describe-secret --secret-id "$NAME" --region "$REGION" "${PROFILE_ARG[@]}" >/dev/null 2>&1; then
  echo "기존 시크릿 발견 → 값 갱신(put-secret-value)" >&2
  ARN=$(aws secretsmanager put-secret-value \
    --secret-id "$NAME" --secret-string "$KEY" \
    --region "$REGION" "${PROFILE_ARG[@]}" \
    --query 'ARN' --output text)
else
  echo "신규 시크릿 생성(create-secret)" >&2
  ARN=$(aws secretsmanager create-secret \
    --name "$NAME" --description "NGC API Key for Omniverse NIM pull" \
    --secret-string "$KEY" \
    --region "$REGION" "${PROFILE_ARG[@]}" \
    --query 'ARN' --output text)
fi

# 키 변수 정리
unset KEY

echo >&2
echo "✅ 완료. 아래 ARN을 배포에 사용하세요:" >&2
echo "$ARN"
echo >&2
echo "예) cdk deploy -c installNim=true -c ngcSecretArn=$ARN ..." >&2
