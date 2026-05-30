# 트러블슈팅 가이드

실배포(2026-05-30, g7e.4xlarge/서울)에서 실제로 겪은 문제와 해결책 위주. 증상 → 원인 → 해결.

---

## 1. 배포(CDK) 단계

### 1-1. SG 생성 실패 — "Character sets beyond ASCII are not supported"
- 증상: `AWS::EC2::SecurityGroup` CREATE_FAILED, 스택 롤백.
- 원인: Security Group `GroupDescription`에 한글(비ASCII) 포함. EC2 SG description은 ASCII만 허용.
- 해결: SG description을 영문으로. (시크릿/CfnOutput description은 비ASCII 허용 — SG만 제약)

### 1-2. 엉뚱한 리전에 배포됨 (예: us-west-2)
- 증상: `createVpc=true`인데 서울이 아닌 다른 리전 AZ로 VPC가 생성됨.
- 원인: CDK가 스택 `env.region`보다 셸 자격증명 기본 리전(`CDK_DEFAULT_REGION`/`AWS_REGION`)을 따라감.
- 해결: 본 프로젝트는 서울 고정. `bin/app.ts`에서 `region`을 명시(`ap-northeast-2`),
  필요 시 `-c region=` 으로만 덮어씀. 배포 전 `aws sts get-caller-identity`로 계정/리전 확인.

### 1-3. g7e 인스턴스 capacity 부족 — "We currently do not have sufficient ... capacity"
- 증상: EC2 생성 실패. g7e는 신형이라 특정 AZ에 물량이 없을 수 있음.
- 원인: 쿼터와 무관한 물리 용량(capacity) 부족. 쿼터가 충분해도 발생.
- 해결: `subnetIndex`로 다른 AZ(2a↔2b) 재시도, 또는 폴백 순서 g7e.4xl → g7e.12xl → g6e.12xl.
  확실히 잡으려면 ODCR(On-Demand Capacity Reservation). (CLAUDE.md 섹션 0-2)

### 1-4. cdk-nag 에러로 synth 실패
- 증상: synth 시 `AwsSolutions-XXX` 에러.
- 원인: 보안 베스트프랙티스 위반(또는 의도적 예외 미처리).
- 해결: 실제 문제면 수정, 의도적이면 `NagSuppressions`에 사유와 함께 추가. (무음 무시 금지)

---

## 2. 부트스트랩(UserData) 단계

부트스트랩 진행/실패는 SSH/SSM 접속 후 `/var/log/omniverse-bootstrap.log` 또는
CloudWatch 로그 그룹에서 확인. 완료 시 `/var/log/omniverse-bootstrap.done` 생성.

### 2-1. apt 락 충돌 — "Could not get lock /var/lib/apt/lists/lock"
- 증상: 부팅 초기 apt 설치가 즉시 실패, 부트스트랩 중단.
- 원인: DLAMI가 부팅 직후 자체 apt 작업(cloud-init 등)을 도는 중 우리 apt와 경합.
- 해결: 부트스트랩에 apt 락 대기(`wait_apt`) + 재시도(`apt_do`) 적용됨. `set -e` 대신
  graceful degrade(실패해도 WARN 후 계속)로 단일 패키지 실패가 전체를 죽이지 않게 함.

### 2-2. cfn-signal 없음 — "/opt/aws/bin/cfn-signal: No such file or directory"
- 증상: 부팅은 됐는데 CloudFormation이 신호를 못 받아 타임아웃 대기.
- 원인: Ubuntu DLAMI에는 `cfn-signal`(cfn-bootstrap)이 그 경로에 없음(Amazon Linux 경로).
- 해결: 본 프로젝트는 cfn-signal/CreationPolicy 미사용. "인스턴스 실행=성공"으로 보고,
  설치 결과는 부트스트랩 로그 + CloudWatch + DCV 진단 체크리스트로 확인.

---

## 3. NIM (AI 추론)

### 3-1. NIM pull 실패 — "not found" (이미지/태그)
- 증상: `docker pull nvcr.io/nim/nvidia/domino-automotive-aero:latest` → not found.
- 원인: `latest` 태그가 없음. 실제 태그는 `1.0.0` / `2.0.0` / `2.1.0-41313772` 등.
- 해결: 정확한 태그 지정. NGC 레지스트리 태그 목록 확인:
  `curl -H "Authorization: Bearer <token>" https://nvcr.io/v2/nim/nvidia/domino-automotive-aero/tags/list`
- 참고: `docker login nvcr.io`(Username `$oauthtoken`)는 성공해도 pull은 태그 때문에 실패할 수 있음.

### 3-2. NIM 컨테이너 재시작 루프 — "Authentication Error" (ManifestDownloadError)
- 증상: `docker ps`에서 nim이 `Restarting`. 로그에 Authentication Error.
- 원인: 컨테이너가 시작 시 모델 가중치를 NGC에서 추가 다운로드하는데 `NGC_API_KEY` 환경변수가 없음.
  (`docker login`은 이미지 pull용일 뿐, 런타임 모델 다운로드엔 env가 별도로 필요)
- 해결: `docker run`에 `-e NGC_API_KEY="$NGC_KEY"` 추가.

### 3-3. NIM 재시작 루프 — "Permission denied (os error 13)"
- 증상: 인증은 통과했는데 모델 캐시 쓰기에서 권한 오류.
- 원인: 컨테이너 비root 사용자가 마운트된 캐시 디렉터리(`/opt/nim/.cache`)에 못 씀.
- 해결: 호스트 캐시 디렉터리 권한 개방 — `mkdir -p /opt/nim/cache && chmod -R 777 /opt/nim/cache`.

### 3-4. 추론 요청이 400/422
- 증상: `/v1/infer/surface` POST에 400/422.
- 원인: 필수 입력 누락. DoMINO는 `design_stl`(STL) + `stream_velocity` + `point_cloud_size`(또는 point_cloud) 필요.
- 해결: multipart/form-data로 전부 전달:
  `curl -F design_stl=@형상.stl -F stream_velocity=30.0 -F point_cloud_size=1000 ...`
- 정상 응답: HTTP 200 + npy ZIP(pressure_surface, drag_force, lift_force 등).

---

## 4. DCV (원격 데스크톱)

### 4-1. DCV 접속 시 "page can't be found" / 404
- 증상: `https://<IP>:8443` 접속 시 404 또는 페이지 없음. (TCP 연결은 됨)
- 원인: DCV web viewer 패키지(`nice-dcv-web-viewer`) 미설치. server/gl만 깔면 8443은 열리나 웹 UI가 없음.
- 해결: web-viewer + xdcv 추가 설치 →
  `apt-get install -y ./nice-dcv-web-viewer_*.deb ./nice-xdcv_*.deb` 후 `systemctl restart dcvserver`.
  (`/usr/share/dcv/www` 생성 + 내부 `curl https://localhost:8443/` 200 확인)

### 4-2. DCV 접속은 되는데 세션 없음 — "There are no sessions available"
- 증상: 로그인 후 검은 화면/세션 없음.
- 원인: 부팅 중 `dcv create-session`이 X 준비 전 실행돼 휘발.
- 해결: dcv.conf에 자동 콘솔 세션 설정(`[session-management] create-session=true`,
  `[session-management/automatic-console-session] owner="ubuntu"`) 후 dcvserver 재시작.
  급하면 수동: `dcv create-session --type virtual --owner ubuntu poc-session`.

### 4-3. 브라우저 TLS 경고 (self-signed)
- 증상: "연결이 비공개가 아닙니다" 경고.
- 원인: DCV 기본 self-signed 인증서.
- 해결: 검증 단계는 "고급 → 계속 진행"으로 정상 사용. 신뢰 인증서 필요 시 `dcvCertSecretArn`로
  사내 CA 인증서 주입(README "DCV TLS 인증서").

---

## 5. Omniverse Kit / RTX

### 5-1. `repo.sh template new` / `launch`가 EOFError로 실패
- 증상: SSM/스크립트로 실행 시 `EOFError`.
- 원인: 대화형 메뉴(앱 종류·이름 선택)가 필수 → 비대화형 환경에서 실패.
- 해결: DCV GUI 터미널에서 사람이 직접 실행. launch는 `-n <app>.kit` 으로 비대화형 가능.

### 5-2. "RTX Loading 0%"에서 멈춘 것처럼 보임
- 증상: USD Composer 첫 실행 시 RTX Loading이 0%에서 오래 멈춤.
- 원인: 멈춘 게 아니라 첫 셰이더 컴파일(수 분, CPU 바운드). 인스턴스 GPU 크기와 무관.
- 해결: 기다리면 완료(228fps 렌더). 진행 확인: `nvidia-smi`에 kit이 GPU 사용 + `top`에서 kit CPU 높음 +
  `~/.cache/ov` 크기 증가. 한 번 캐시되면 다음 실행은 수십 초.

---

## 6. 브라우저 WebRTC 스트리밍

### 6-1. web-viewer 페이지는 뜨는데 빈 화면
- 증상: "Omniverse Embedded Web Viewer" 페이지만 보이고 3D 없음.
- 원인: UI 옵션에서 "USD Viewer app"(1번)을 선택. USD Composer 등 임의 앱은 2번이어야 함.
- 해결: "UI for **any** streaming app"(2번) 선택 → Next.

### 6-2. 자동차 로드 후 흰 화면 / 연결 끊김
- 증상: USD 로드 직후 흰 화면이 되거나 스트림이 끊김.
- 원인: 머티리얼/환경 텍스처를 S3에서 로딩하는 동안 WebRTC 세션 일시 끊김.
- 해결: 브라우저 새로고침/재연결 → 완성 렌더(머티리얼·배경 포함)가 나옴. (정상 과정)

### 6-3. 연결 안 됨 / 미디어 없음 (클라우드)
- 증상: signaling은 되는데 영상이 안 옴.
- 원인: WebRTC 미디어가 UDP 동적 포트 + 공인 IP ICE 후보 매칭 필요. 클라우드에서 까다로움.
- 해결: Kit launch 시 `--/app/livestream/publicEndpointAddress=<EIP>` 지정.
  SG에 UDP(1024, 47995-48012, 49000-49007) + signaling 49100 + web 5173 개방 확인.

---

## 7. 일반 점검 명령 (SSM/DCV 터미널)

```bash
nvidia-smi                                  # GPU 인식/사용 프로세스
docker ps && docker logs nim | tail -30     # NIM 상태/로그
curl -k http://localhost:8000/v1/health/ready   # NIM health(200)
dcv list-sessions                           # DCV 세션
ss -tlnp | grep -E '8443|49100|5173'        # 포트 리스닝
vulkaninfo --summary                        # Vulkan/GPU (Kit 렌더 가능 여부)
tail -50 /var/log/omniverse-bootstrap.log   # 부트스트랩 로그
```
