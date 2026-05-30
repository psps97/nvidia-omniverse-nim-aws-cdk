# NVIDIA Omniverse on AWS — 디지털 트윈 PoC CDK 프로젝트

산업 설비 디지털 트윈 구축을 목적으로, NVIDIA Omniverse(Kit/RTX, Nucleus 미사용)
+ NIM을 AWS GPU 인스턴스에 배포하기 위한 AWS CDK 프로젝트.
이 문서는 구현 전 합의된 요구사항/설계 결정을 정리한 초안이다. (작성일: 2026-05-29)

---

## 0-0. 프로젝트 목적 및 구성요소 관계 (USD · Omniverse · NIM)

목적: 산업 설비의 디지털 트윈을 구성한다.
디지털 트윈 = "현실 설비/공정을 반영해 계속 갱신되는 3D 가상 모델".

세 가지 구성요소의 역할 분담:

```
[ USD ]         디지털 트윈의 데이터 포맷/씬 (3D 세계를 기술하는 파일·언어)
   ↑
[ Omniverse ]   USD 씬을 열고·편집·렌더링·시뮬레이션·협업하는 플랫폼/엔진
   ↑
[ NIM ]         씬을 AI로 생성·검색·이해하게 돕는 AI 마이크로서비스 (보조)
```

비유: USD=3D용 문서 포맷, Omniverse=그 문서의 에디터+렌더러+협업서버, NIM=AI 비서.

| 요소 | 역할 | 디지털 트윈에서 | 본 PoC 비중 |
|------|------|-----------------|-------------|
| USD (OpenUSD) | 3D 씬 기술 표준 포맷 | CAD/센서/BIM을 하나의 씬으로 합성 → 트윈의 뼈대 | 데이터 기반 |
| Omniverse Kit | 앱 SDK/런타임 | 트윈을 보고·편집·시뮬레이션 (USD Composer 등) | 핵심(필수) |
| Omniverse RTX | 실시간 사실적 렌더러 | 산업 설비를 GPU로 시각화 (L40S/RTX PRO 6000) | 핵심(필수) |
| Omniverse Nucleus | 협업 서버 | 팀이 같은 트윈 씬을 실시간 공유 | 선택(협업 시) |
| NIM | AI 마이크로서비스 | USD Code(자연어→씬 생성), USD Search(에셋 검색) 등 | 선택(가속) |

디지털 트윈 워크플로우(셋이 만나는 흐름):

```
1. 현실 데이터(CAD/센서/BIM) → USD 씬으로 변환·합성
2. Omniverse Kit에서 USD 씬을 열어 시각화·시뮬레이션 (RTX 렌더링)
3. NIM이 AI로 보조: USD Code(씬 생성/수정), USD Search(에셋 검색)
4. Nucleus로 팀이 같은 트윈을 실시간 공유
5. 결과를 USD로 저장 → 현실 변화에 맞춰 반복 갱신
```

PoC 우선순위 (중요):
- 1순위(필수): Omniverse Kit + RTX 구동 — USD 씬을 열고 렌더링되는지. 트윈의 본체.
- 2순위(선택): NIM 연동 — USD Code/Search로 AI 보조. 없어도 트윈은 성립.
- 시사점: 온프렘은 보조(NIM)만 되고 본체(Kit)가 막힌 상태였음 → 본 PoC는
  Kit 구동을 최우선 검증 대상으로 둔다. (NIM은 `installNim` 옵션)

---

## 0-1. 참조 아키텍처: Omniverse Blueprint (Digital Twins for Fluid Simulation)

고객이 구성하려는 대상 = NVIDIA 공식 Blueprint
`github.com/NVIDIA-Omniverse-blueprints/digital-twins-for-fluid-simulation`.
세 축: AI 유동 해석(NIM) + Omniverse 3D 실시간 렌더링(Kit) + WebRTC 브라우저 스트리밍.

### 구성요소 (Docker Compose, standard=4 컨테이너 / lite=3)

| 서비스 | 역할 | 포트 |
|--------|------|------|
| `aeronim` | Triton + DoMINO-Automotive-Aero 모델, USD→추론→NanoVDB 필드 반환 | 8080(내부) |
| `kit` | Omniverse Kit 렌더러(헤드리스), WebRTC 스트리밍, 추론 캐시 | WebRTC(아래) |
| `web` | Trame 웹 UI(파라미터 슬라이더, 결과 패널) | 5173(내부) |
| `launch-proxy` | nginx 리버스 프록시(단일 진입점) | 80/443 |

데이터 흐름:
```
브라우저 ─HTTP→ launch-proxy ─→ Trame(UI)
브라우저 ─WebRTC 시그널링→ launch-proxy(/sign_in) ─→ Kit
브라우저 ─WebRTC 미디어(UDP)→ Kit (프록시 우회, 직접)
Trame ─set_state→ Kit ─→ aeronim(Triton 8080) ─NanoVDB→ Kit ─렌더→ WebRTC→ 브라우저
```

### 중요 사실 (지금까지 가정과 달라진 점)

- 배포: Docker Compose(주) / Helm / 리포 내장 AWS CDK(5스택). → 우리가 처음부터
  짜지 않고 리포의 `deploy/aws-cdk/`를 기반으로 커스터마이징.
- ⚠️ 실증 확인(2026-05-30): `docker compose --profile lite up --build`는 외부 일반
  AWS 환경에서 실패한다. `kit-cae` 이미지의 from-source 빌드(`./repo.sh build`)가
  `urm.nvidia.com`(NVIDIA 사내 Artifactory, 외부 DNS 응답 없음)에 의존하기 때문.
  - trame-app·launch-proxy 이미지는 빌드 성공(외부 의존 없음), kit-cae만 막힘.
  - 즉 Blueprint 전체 스택은 "임의 호스트에서 compose up --build"로 안 됨.
    NVIDIA 의도 경로 = build.nvidia.com 호스팅 데모 체험, 또는 리포의
    `deploy/aws-cdk`(prebuilt 이미지 pull 가정) 사용. → 본 PoC 범위 밖, 별도 과제.
  - 우리 단독 NIM(`nvcr.io/nim/nvidia/domino-automotive-aero`) pull·추론은 정상(검증됨).
    Blueprint의 aeronim과는 별개 경로.
- ✅ 실증 확인(2026-05-30): 브라우저 WebRTC 스트리밍은 Blueprint 없이 순수 Kit으로 됨.
  - kit-app-template에 streaming 설정(`omni.kit.livestream.app`/`.webrtc`) + base 앱으로
    build → `--enable omni.kit.livestream.app --/app/livestream/publicEndpointAddress=<EIP>`로
    launch → 49100(signaling) LISTEN. web-viewer-sample("any streaming app" 선택)로
    브라우저 접속 → USD Composer 3D 뷰포트 스트리밍 + 양방향 입력(Variant 색상 변경 실시간).
  - 핵심: Kit streaming은 urm.nvidia.com 의존 없음 → 외부 AWS에서 빌드·구동됨
    (Blueprint kit-cae 빌드가 막히는 것과 대조). 단독 NIM 추론과 합치면 사실상 Blueprint
    standard와 동등한 데모를 우회 구성 가능. 절차/스크린샷: README "5) 브라우저 WebRTC".
- 화면 전달: Kit 내장 WebRTC 스트리밍 (DCV 아님). 완성 뷰포트를 브라우저로 스트리밍.
- Nucleus: 불필요 (로컬 USD 파일/볼륨 사용).
- 라이선스: NVAIE 불필요. NGC API Key(무료 티어)만 있으면 standard 동작.
- GPU(중요): lite는 단일 GPU 16GB+면 충분. standard는 Kit/AeroNIM을 GPU 0/1로
  분리 → "40GB+ ×2" 또는 "80GB+ ×1" 권장. L40S 48GB ×1로는 standard 단일 GPU 임계
  (80GB) 미달 → standard는 멀티 GPU(g6e.12xlarge/g7e) 또는 GPU 분리 권장.
- 네트워크: 기본 HTTP + IP 기반 접근제어(`allowedIpRanges`). 도메인/TLS/Route53 불필요
  (Nucleus 엔터프라이즈 설치와 달리 단순). 클라우드는 `RTWT_PUBLIC_IP`로 ICE 후보 지정.

### ⚠️ 용도 적합성 (반드시 인지)

- 이 Blueprint의 NIM(DoMINO-Automotive-Aero)은 자동차 외부 공력 전용 학습 모델.
  샘플도 자동차(스포일러/미러/휠). 다른 산업 도메인 유동에 그대로는 부적합.
- 재사용 가능: 시각화 스택(Kit 헤드리스 렌더 + WebRTC + Trame Web)은 범용 →
  대상 USD 시각화/스트리밍 용도로 활용 가능.
- 부적합: 타 도메인 유동 예측을 하려면 해당 도메인으로 학습된 모델 필요
  (DoMINO 재학습=ML 엔지니어링 과제) 또는 전통 CFD(OpenFOAM/Fluent) 사용.
- PoC 전략: (1) lite로 Blueprint 구동·스트리밍 파이프라인 검증 → (2) 시각화 스택을
  대상 USD로 교체 검증 → (3) 유동 예측은 별도 모델/CFD 과제로 분리.

### 두 가지 화면 접근이 모두 필요 (DCV + WebRTC)

- WebRTC(Blueprint 내장): 완성된 트윈/시뮬 뷰포트를 브라우저로 시연·공유 (최종 사용자).
- DCV(데스크톱 원격): Kit 앱 개발, CAD→USD 변환, USD Composer 씬 편집, 디버깅 (작업자).
- 둘은 용도가 다르므로 병행한다. 트윈을 "만드는" 작업엔 DCV, "보여주는" 데 WebRTC.

---

## 0. 배경 / 추진 근거 (온프렘 이슈 → AWS 2안)

온프렘 R&D 워크스페이스(Docker 기반 GPU 서버)에서 Omniverse 설치 테스트 시
NIM까지는 설치됐으나 Kit 설치/이후 단계가 진행되지 않음. 추정 원인과 AWS 대응:

| 온프렘 이슈 | AWS 2안(IaaS/BYOL)에서의 해결 |
|------|------|
| ① GPU(L40S)가 권장사양과 불일치(추정) | L40S는 Omniverse 공식 지원 GPU → 실제 원인은 ②④일 가능성 큼 |
| ② 사내 보안정책 외부 인터넷 차단 → rpm/이미지 다운로드 불가 | NAT Gateway 또는 사내 프록시로 아웃바운드 허용 → 해결 |
| ③ 개인 PC Docker Desktop 실행 제한 | EC2 자체가 Docker 호스트 → 개인 PC 무관, 해결 |
| ④ 관리자 권한 없어 사용자 직접 설치 불가 | EC2는 본인이 root/sudo 보유 → 자유 설치, 해결 |

핵심: 온프렘 실패는 대부분 환경 제약(인터넷 차단·권한·개인PC)이지 GPU 한계가 아님.
AWS에서는 ②③④가 구조적으로 해소되고, GPU도 동일 L40S 세대로 검증 이관이 용이.

### 인스턴스 추천 (Omniverse PoC 기준)

- 서울 리전 GPU 인스턴스 두 갈래가 Omniverse에 적합:
  - g6e = L40S(Ada) 48GB / g7e = RTX PRO 6000 Server(Blackwell) 96GB
  - 참고: 요구사양 "RTX Pro 6000급"은 AWS g7e로 클라우드에서 충족 가능
- 1순위(기본): `g7e.4xlarge` (RTX PRO 6000 96GB ×1) — 단일 GPU로 NIM+Kit 풀스택
  구동 충분, 비용 최적. 요구사양 "RTX Pro 6000급" 충족.
- 다중 세션/대형 워크로드: `g7e.12xlarge` (RTX PRO 6000 ×2, 192GB)
- 대안(L40S 계열): `g6e.4xlarge`(L40S 48GB ×1) — NVIDIA Omniverse 권장 GPU,
  온프렘 R&D 서버와 동일 GPU라 검증/이관 용이. `g6e.12xlarge`(L40S ×4, 192GB)
- 이 4종만 CDK 입력 인자로 허용 (g5/g6 등 기타 제외)

---

## 0-2. 최종 사양 (Omniverse NIM CAE PoC) — 교차 대조 결과

AI-Powered CAE 시각화 데모. Pre-trained CFD NIM + Kit-CAE를 EC2에서
구동하고 브라우저로 접속. 별도 작성된 사양서를 본 문서 확인값과 교차 대조한 결과:

### ✅ 일치 (사양서 그대로 채택)

- 목적/아키텍처: Pre-trained CFD NIM + Kit-CAE + EC2 + 브라우저 접속 — 타당.
- OS/드라이버: Ubuntu 22.04 / R580+(Blackwell, g7e) · R570+(Ada, g6e) — 정확.
- SW 스택: Driver → Docker + Container Toolkit → NIM(NGC pull) → Kit-CAE → DCV — 정확.
- CFD NIM: Pre-trained = DoMINO-Automotive-Aero(자동차 공력). 타 도메인은 Phase 2.
- 데이터: 샘플 CFD(OpenUSD) S3 → EC2 로컬. NVIDIA 샘플 또는 STAR-CCM+ 변환.
- 서울 리전 g7e 가용성(실측 2026-05-29, 베이와치): g7e.4xlarge 소량 가용(~5대 수준),
  g7e.12xlarge는 용량 거의 0 → 단일 GPU(4xl) 우선, 12xl 미가용 시 g6e.12xl 폴백.
  capacity는 시점·AZ별 변동 → 배포 직전 재확인 필수.
- 데모 플로우(형상 파라미터 변경 → NIM 추론 → 압력장/유속 실시간 렌더): Blueprint와 일치.

### ⚠️ 정정 / 보완 필요 (사양서 수정)

1. 비용 정정 (중요):
   - 사양서 "g7e.12xlarge ~$7-8/hr" → 실측 $10.187/hr (서울, 2026-05-29 Pricing API).
   - 월 40시간 ≈ $407/월 (사양서 $320은 과소 추정). EBS 500GB gp3 ≈ $40/월 별도.
   - g7e.4xlarge는 $4.916/hr → 월 40h ≈ $197/월. 단일 GPU PoC엔 이쪽이 더 합리적.

2. 인스턴스 1순위 재검토:
   - VRAM 산정: AeroNIM ~40GB + Kit ~15GB ≈ 55GB. RTX PRO 6000 96GB 단일로 충분.
   - 따라서 g7e.12xlarge(96GB ×2)는 단일 GPU PoC엔 과사양. g7e.4xlarge(96GB ×1)로
     standard 풀스택(NIM+Kit) 구동 가능 → 1순위를 g7e.4xlarge로 권장(비용 절반↓).
   - g7e.12xlarge는 멀티 워크로드/동시 다중 세션 필요 시로.
   - g6e.12xlarge(L40S 48GB ×4)는 GPU 분리(Kit=0, NIM=1) 방식 대안.

3. 접근 방식 — DCV + WebRTC 둘 다 포함 (확정):
   - 사양서는 DCV(8443)만 명시 → WebRTC도 포함으로 확정.
   - DCV = Kit-CAE GUI 직접 조작/개발용. WebRTC = 완성 데모 브라우저 시연용(Blueprint 기본).
   - SG에 WebRTC 포트(80/443, 49100, 1024/udp, 47995-48012, 49000-49007) 추가 (섹션 3).
   - 클라우드 배포 시 `RTWT_PUBLIC_IP`로 Kit에 외부 도달 IP 지정 필요.

4. 네트워크/보안 — 운영=private, 검증=public 둘 다 (확정):
   - 운영(사내): `deploymentMode=private` — 사내망 VPN/DX, 프라이빗 서브넷, 공인 IP 없음.
   - 검증: `deploymentMode=public` — 랜딩존 밖 단독 테스트용. 사양서 Public Subnet에 해당.
   - 두 모드를 코드 한 벌로 토글. `allowedCidr` 절대 0.0.0.0/0 금지(합성 단계 차단).
   - 외부 트래픽 허용 필수(차단 금지 — 온프렘 실패 원인):
     `pypi.nvidia.com` / `*.nvidia.com`(Kit 레지스트리) / `nvcr.io`+NGC CDN / apt 미러.
     랜딩존 SCP/방화벽/프록시 화이트리스트 등록 필요 (섹션 3, README).

5. 디스크: 사양서 500GB gp3 적정. (NIM 컨테이너 ~31GB + 샘플 USD + 캐시 여유 포함).
   루트/데이터 분리는 선택(섹션 4). PoC 단일 볼륨 500GB도 무방.

### 결론

사양서는 전반적으로 적합. 확정/수정 사항:
- (a) 비용 정정: g7e.12xlarge $10.2/hr (사양서 $7-8 → 실측), 월 40h ≈ $407.
- (b) 1순위 인스턴스: 단일 GPU로 충분하므로 g7e.4xlarge 권장(비용 절반).
- (c) 접근: DCV + WebRTC 둘 다 포함 (확정).
- (d) 네트워크: 운영=private(사내망) + 검증=public(테스트) 둘 다, 코드 한 벌로 토글.
- (e) 외부 도메인 허용 필수 (pypi.nvidia.com 등) — 랜딩존 방화벽 화이트리스트.

---

## 0-3. NIM ↔ Omniverse 연동 구조 (AI-Powered CAE 파이프라인)

NVIDIA의 AI-Powered CAE 워크플로우에서 NIM과 Omniverse가 어떻게 맞물리는지 정리.
(섹션 0-1 Blueprint의 데이터 흐름을 "왜 그렇게 도는가" 관점에서 보강)

### 전체 파이프라인 (학습 → 배포 → 시각화)

```
[데이터 전처리]          [AI 모델 학습]          [추론/배포]            [시각화]
PhysicsNeMo Curator → PhysicsNeMo Train → NIM 마이크로서비스 → Omniverse Kit-CAE
 (메시/포인트클라우드     (CFD surrogate 등       (학습 모델을 API로      (추론 결과를
  정제·변환)              물리 모델 학습)          서빙하는 추론 엔진)      3D 실시간 렌더)
```

| 컴포넌트 | 역할 | 본 PoC 범위 |
|----------|------|-------------|
| PhysicsNeMo Curator | CFD 데이터 전처리(메시/포인트클라우드 정제) | Phase 2 (커스텀 모델 시) |
| PhysicsNeMo Train | AI 물리 모델 학습 (CFD surrogate 등) | Phase 2 (커스텀 모델 시) |
| NIM | 학습된 모델을 API로 서빙 (추론 엔진) | Phase 1 (pre-trained pull) |
| Omniverse Kit-CAE | NIM 추론 결과를 3D로 실시간 시각화 | Phase 1 (핵심) |

> PoC(Phase 1)는 학습 단계를 건너뛰고 pre-trained NIM(DoMINO-Automotive-Aero)을
> NGC에서 pull → Kit-CAE로 시각화까지만 검증한다. PhysicsNeMo(Curator/Train)는
> 대상 도메인 커스텀 모델이 필요해지는 Phase 2 과제 (섹션 0-2 "용도 적합성" 참고).

### 연동 방식 (실시간 인터랙티브 루프)

1. NIM이 추론 서버로 동작
   - 입력: 형상 데이터 (메시, 포인트 클라우드)
   - 출력: 물리량 예측 (압력, 온도, 유속 등 → Blueprint에선 NanoVDB 필드)
2. Kit-CAE가 NIM API 호출
   - Kit-CAE에서 형상 변경 → NIM에 추론 요청 → 결과를 실시간 렌더링
   - OpenUSD 포맷으로 시뮬레이션 데이터 교환
3. 실시간 루프:

```
사용자가 Kit-CAE에서 설계/형상 변경
    ↓
NIM API로 AI 추론 요청 (수 초)
    ↓
결과(압력장/유동장)를 Kit-CAE에서 3D 시각화
    ↓
기존 CFD 수 시간 → AI surrogate 수 초 (핵심 가치 제안)
```

- 핵심 가치: 전통 CFD(OpenFOAM/Fluent)는 수 시간~수일 → AI surrogate(NIM)는 수 초.
  설계 파라미터를 바꿔가며 "거의 실시간"으로 압력장/유동장을 탐색하는 것이 데모 포인트.

---

## 1. 확정된 결정사항 (Decisions)

| 항목 | 결정 | 비고 |
|------|------|------|
| IaC 도구 | AWS CDK | CLI v2.1118 설치됨 |
| CDK 언어 | TypeScript | node/npm 설치됨 |
| OS | Ubuntu 22.04 | Omniverse NIM은 Linux 컨테이너 전용. Windows 미지원 |
| 인스턴스 타입 | g7e.4xlarge(기본)/g7e.12xlarge/g6e.4xlarge/g6e.12xlarge | 입력 인자(`instanceType`)로 택1. 그 외 미허용 |
| 리전 | ap-northeast-2 (서울) | 4종 az 2a/2b 제공. 단 g7e.12xl 용량 거의 0(실측) → 섹션 0-2 |
| 베이스 AMI | DL Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04) | NVIDIA 드라이버 사전설치 |
| 참조 아키텍처 | Omniverse Blueprint (fluid-simulation) | Docker Compose 기반, 리포 내장 CDK 참고 (섹션 0-1) |
| 접근 방식 | SSH(22) + DCV(8443, 작업용) + WebRTC(Web 시연용) | DCV=만들기, WebRTC=보여주기. 병행 |
| DCV 비밀번호 | AWS Secrets Manager로 관리 | 부팅 시 주입 |
| 배포 구성 | 단일 인스턴스(기본) | standard 프로파일은 멀티 GPU 권장(GPU 분리) |
| 네트워크 노출 | `deploymentMode`로 분기 | private(기본,사내전용)/public(테스트). `0.0.0.0/0` 금지 |
| 배포 방식 | AWS 2안 (IaaS, BYOL) | 마켓플레이스 AMI 미사용. SW 직접 설치, 라이선스 고객 보유 |
| 시작/중지 | 수동 관리 | 자동 스케줄링 미적용 (사용자가 stop/start) |
| 백업 | 설치 완료 후 AMI 생성 | 재구축/스케일아웃 가속, 온프렘 삽질 반복 방지 |
| 보안 점검 | cdk-nag 포함 | 합성 시 보안 베스트프랙티스 자동 검사 |
| 모니터링 | CloudWatch agent + GPU 메트릭 | GPU 사용률/VRAM/온도 수집 |

### OS / AMI 선택 근거
- Omniverse NIM은 Docker + NVIDIA Container Toolkit 기반 Linux 컨테이너로만 배포됨.
- Windows Server는 NIM 컨테이너를 정식 지원하지 않음 → Ubuntu 22.04 LTS 채택.
- 베이스 AMI: AWS "Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)" 권장.
  - NVIDIA GPU 드라이버가 사전 설치되어 부트스트랩이 단순/안정적
    (드라이버 컴파일·재부팅 불필요). Docker/Container Toolkit은 부트스트랩에서 설치/검증.
  - "Base" 계열 선택 이유: PyTorch/TF 등 무거운 프레임워크가 없는 경량 베이스라
    NIM 컨테이너 호스트로 적합 (불필요한 용량/패키지 배제).
  - 하드코딩 대신 SSM public parameter로 항상 최신 AMI 조회:
    `/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id`
    (CDK `MachineImage.fromSsmParameter` 사용 → 리전 이동/AMI 갱신에도 자동 대응)
  - 서울 리전 확인된 최신 AMI 예시(2026-05-26 빌드): `ami-08eb12a69d55585f1`
    (참고용 — 실제 배포 시 SSM 파라미터로 최신값 사용)
  - AMI 소유자(AWS DLAMI 계정): `898082745236`

---

## 2. 인스턴스 / 컴퓨트 요구사항

인스턴스 타입은 CDK 입력 인자(`instanceType`)로 받되, 아래 허용 목록으로만 제한한다.
g5/g6 등 기타 타입은 허용하지 않음 (입력값 검증으로 차단).

| 인자값 | GPU | GPU당 VRAM | vCPU | 메모리 | 용도 |
|--------|-----|-----------|------|--------|------|
| `g7e.4xlarge` (기본) | RTX PRO 6000 ×1 | 96GB | 16 | 128 GB | 기본 PoC. 단일 GPU로 NIM+Kit 풀스택, 비용 최적 |
| `g7e.12xlarge` | RTX PRO 6000 ×2 | 96GB | 48 | 512 GB | 최신 Blackwell, 다중 세션/대형 워크로드 |
| `g6e.4xlarge` | L40S ×1 | 48GB | 16 | 128 GB | 대안. 온프렘 L40S 검증 이관 |
| `g6e.12xlarge` | L40S ×4 | 48GB | 48 | 384 GB | Kit + 대형/다중 NIM 동시 (GPU 분리) |

- GPU 계열 두 갈래:
  - g6e = L40S(Ada) 48GB — 온프렘 R&D 서버와 동일 GPU, 검증 이관 정합성 최우선
  - g7e = RTX PRO 6000 Server(Blackwell) 96GB — 요구사양 "RTX Pro 6000급",
    GPU당 VRAM 2배. 단 최신 세대라 단가 높음 (배포 전 서울 단가 확인)
- 허용 4종 모두 서울 리전 az `2a`, `2b`에 가용 (2c/2d 없음) → 서브넷은 2a/2b 배치
- 입력값이 허용 목록에 없으면 합성(synth) 단계에서 에러 처리
- 루트 EBS: gp3, 500GB (OS/컨테이너 이미지/모델 캐시 통합 — 섹션 4)
- IMDSv2 강제, 상세 모니터링 옵션

---

## 3. 네트워크 (VPC / Security Group)

두 가지 배포 모드를 `deploymentMode` 파라미터로 전환한다.
운영(사내 전용)과 랜딩존 밖 테스트(임시 public 접근)를 코드 한 벌로 지원한다.

### 배포 모드 (`deploymentMode`)

| 모드 | 서브넷 | 공인 IP | 접속 주소 | 용도 |
|------|--------|---------|-----------|------|
| `private` (기본) | 프라이빗 | 없음 | 고정 프라이빗 IP | 운영, 사내 전용 (VPN/DX) |
| `public` (테스트) | 퍼블릭 | EIP 부여 | EIP(고정 공인 IP) | 랜딩존 밖 단독 테스트 |

- 기본값은 `private`. `public`은 명시적으로 지정해야만 활성화 (실수 방지).
- 모드에 따라 서브넷 선택·퍼블릭 IP·EIP·라우팅이 분기된다.

### VPC / 서브넷
- `private`: 미리 생성된 기존 VPC를 파라미터(`vpcId` + 프라이빗 `subnetIds`(2a/2b 다중)
  + `availabilityZones`)로 입력받아
  사용 (신규 생성 안 함). VPN·DX 연결 VPC여야 사내 접근 가능.
  `ec2.Vpc.fromLookup`/`fromVpcAttributes`로 참조.
- `public`: 기존 VPC의 퍼블릭 서브넷 사용, 또는 테스트용 신규 VPC를 생성 옵션으로 허용
  (`createVpc=true` 시). IGW/퍼블릭 라우팅 포함.
- 아웃바운드(NGC pull): `private`=NAT/프록시/VPC Endpoint, `public`=IGW 경유.
- S3 VPC Endpoint(Gateway형, 무료) 권장(특히 private): 파일 업·다운을 인터넷 없이.

#### ⚠️ 필수 아웃바운드 허용 도메인 (외부 트래픽 차단 금지)

랜딩존/사내 폐쇄망에서 외부 트래픽을 막으면 Omniverse Kit·CAD Converter·NIM이
설치/동작하지 않는다 (온프렘 실패의 핵심 원인). 아래 아웃바운드 443을 허용한다:

| 도메인 | 용도 |
|--------|------|
| `pypi.nvidia.com` | Kit / 익스텐션(CAD Converter 등) 패키지 |
| `*.nvidia.com` (Kit 레지스트리) | Kit 익스텐션 레지스트리 |
| `nvcr.io` + NGC CDN | NIM / 컨테이너 이미지 pull |
| Ubuntu / Docker apt 미러 | OS 패키지 |

- 폐쇄망이 불가피하면 사전 미러링(사내 ECR + PyPI 미러 + 오프라인 익스텐션 번들) 필요.
- 랜딩존 SCP/방화벽/프록시 정책에서 위 도메인 화이트리스트 등록 필수.
- README에도 동일 내용을 명시(인프라 구성도 + 유의사항).

### 접속 주소 (고정 IP)
- `private`: 고정 프라이빗 IP(`PrivateIpAddress` 지정 또는 ENI 고정).
  stop/start 시에도 사설 IP 불변. → CloudFormation Output 노출.
- `public`: EIP 할당·연결(`ec2.CfnEIP` + `CfnEIPAssociation`). stop/start 시 공인 IP
  불변. → EIP를 Output 노출. (테스트 종료 후 스택 삭제 시 EIP 해제)

### Security Group (인바운드)

| 포트 | 프로토콜 | 용도 | 소스 |
|------|----------|------|------|
| 22 | TCP | SSH 관리 접속 | `allowedCidr` |
| 8443 | TCP | Amazon DCV 원격 데스크톱 (작업/개발용) | `allowedCidr` |
| 80 / 443 | TCP | Blueprint launch-proxy (Web UI 진입점) | `allowedCidr` |
| 49100 | TCP | Kit WebRTC 시그널링 | `allowedCidr` |
| 1024 | UDP | Kit WebRTC 미디어 | `allowedCidr` |
| 47995-48012 | TCP+UDP | Kit WebRTC 전송 | `allowedCidr` |
| 49000-49007 | TCP+UDP | Kit WebRTC 데이터 | `allowedCidr` |
| 8000~ | TCP | (옵션) 별도 NIM 추론 API | `allowedCidr` (모델별 포트 확인) |

- WebRTC 미디어는 launch-proxy를 우회해 Kit에 직접 연결 → UDP 포트 개방 필요.
- 클라우드 배포 시 `RTWT_PUBLIC_IP`로 Kit에 외부 도달 IP를 알려줘야 ICE 후보가 맞음.

### 허용 CIDR 정책 (`allowedCidr`) — 두 모드 공통 안전장치

- `private`: 사내망(VPN/DX 너머) 대역. 기본 `10.0.0.0/8`, 실제 대역은 고객 질의 후 확정.
- `public`: 반드시 접속자 IP를 `x.x.x.x/32`처럼 좁게 입력 (예: 본인 사무실/집 공인 IP).
- ⚠️ `0.0.0.0/0`은 두 모드 모두 금지. 입력 시 합성(synth) 단계에서 에러로 차단.
  - public 모드에서 DCV를 인터넷 전체에 노출하는 사고 방지 (가장 중요한 가드레일).
- DCV는 HTTPS(8443) + Secrets Manager 비번으로 보호되나, IP 제한은 별개로 필수.
- 다중 대역 입력 지원 검토(콤마 구분 → SG 규칙 다중 생성).

---

## 4. EBS / 스토리지

PoC는 단일 pre-trained NIM + Kit 구동 규모라, 루트 볼륨 하나(500GB gp3)로 통합한다.
(NIM 이미지 ~30GB + 모델 캐시 수십 GB + 샘플 USD + Kit 캐시 다 합쳐도 100~200GB 수준
→ 500GB로 충분한 여유). 별도 데이터 볼륨 분리는 본 PoC에선 불필요.

### 볼륨 구성

| 볼륨 | 용도 | 타입 | 용량(기본) | IOPS | 처리량(Throughput) |
|------|------|------|-----------|------|---------------------|
| 루트 (`/`) | OS, Docker, 드라이버, 컨테이너 이미지, NIM 모델 캐시(`/opt/nim/cache`), 샘플 USD | gp3 | 500GB | 6,000 | 400 MB/s |

### EBS 볼륨 타입 선정 근거

- gp3 (기본 권장): 용량과 무관하게 IOPS·처리량을 독립적으로 프로비저닝 가능.
  baseline 3,000 IOPS / 125 MB/s에서 최대 16,000 IOPS / 1,000 MB/s까지 상향.
  대부분의 NIM 모델 로딩/캐시 워크로드에 비용 대비 최적.
- io2 Block Express (고성능 옵션): 일관된 초고 IOPS(최대 256,000)와 sub-ms 지연,
  99.999% 내구성이 필요한 경우. gp3 대비 고비용 → 단일 NIM 추론 노드에는 보통 과함.
  대규모 동시 모델 스왑/극심한 랜덤 IO 병목이 실측될 때만 승격 검토.
- st1/sc1(HDD)는 부적합: 랜덤 IO 및 컨테이너/모델 로딩 지연에 불리. 사용 안 함.

### 용량 산정 가이드

- 컨테이너 이미지: Omniverse NIM 이미지 1개당 수~수십 GB (DoMINO ~30GB대)
- 모델 가중치/캐시: 모델·정밀도(FP16/INT8)에 따라 수십 GB
- 위를 다 합쳐 100~200GB 예상 → 500GB 기본으로 여유 확보.
  대형/다중 NIM을 추가하면 용량 파라미터를 상향(또는 데이터 볼륨 분리)으로 대응.
- IOPS/처리량은 인스턴스 EBS 대역폭 상한 내에서 설정
  (인스턴스별 EBS 대역폭 한계를 초과 프로비저닝하지 않도록 확인 필요)

### 설정/운영

- 용량·IOPS·처리량·볼륨 타입 모두 CDK context/파라미터로 조정 가능하게 설계
- NIM 모델 캐시 경로(`/opt/nim/cache`)는 루트 볼륨 내 디렉터리로 생성(부팅 시 mkdir)
- EBS 기본 암호화(KMS) 적용
- 스냅샷/삭제 정책: 스택 삭제 시 볼륨 보존(retain) 여부 파라미터화
- (옵션) 대형/다중 NIM·공유 캐시 필요 시 데이터 볼륨 분리 또는 FSx for Lustre 검토

---

## 5. SW 설치 절차 (AWS 2안 IaaS/BYOL — 직접 설치)

마켓플레이스 AMI를 쓰지 않으므로 GPU SW 스택을 직접 설치한다 (AWS 2안, BYOL).
EOL된 Omniverse Launcher 방식은 제외하고, 현행 권장 방식(Kit 기반 앱 + NIM 컨테이너)을 채택.
부트스트랩(UserData)은 드라이버·DCV·NIM 런타임까지 자동화하고,
Kit 앱/라이선스는 DCV 접속 후 수동 진행한다(아래 5-2).

### 5-0. 전체 필요 패키지 스택 (5계층)

> 온프렘 이슈 핵심: NIM은 GPU 연산(CUDA)만 쓰므로 드라이버 + 컨테이너 런타임만으로 동작.
> 반면 Kit은 실시간 3D 렌더링 엔진이라 Vulkan + GL + X11 디스플레이 스택이 추가로 필요.
> "NIM 성공 / Kit 실패"의 전형적 원인 = Vulkan 로더(`libvulkan1`)·GL/X11 라이브러리·
> DISPLAY 부재 + (온프렘) 인터넷 차단으로 해당 패키지 다운로드 자체 불가.

계층별 정리 (Ubuntu 22.04 기준):

| 계층 | 목적 | 핵심 구성 | NIM 필요 | Kit 필요 |
|------|------|-----------|:-------:|:-------:|
| ① GPU 드라이버 | GPU 인식/Vulkan ICD 제공 | `nvidia-driver-580`(+580.65↑), `linux-headers` | ✅ | ✅ |
| ② 컨테이너 런타임 | NIM 컨테이너 실행 | `docker-ce` 일체, `nvidia-container-toolkit` | ✅ | ✖ |
| ③ Kit 빌드 도구 | kit-app-template 빌드 | `build-essential` `git` `git-lfs` `curl` `wget` | ✖ | ✅ |
| ④ Kit 런타임 라이브러리 | 3D 렌더/UI 구동 | Vulkan/GL/X11/폰트/오디오 (아래) | ✖ | ✅ |
| ⑤ 원격 디스플레이 | GUI 원격 접속 | Amazon DCV + `nice-dcv-gl`(→ 신버전 `amazon-dcv-gl`) + Xorg(NVIDIA) | ✖ | ✅(GUI) |
| ⑥ Python 3.12 | CAD 변환/USD 스크립팅 | `python3.12` `-venv` `-dev` (deadsnakes) | ✖ | △(도구) |

핵심 주의:
- CUDA Toolkit은 호스트에 불필요 (Kit은 자체 컴퓨트 라이브러리 번들, NIM은 컨테이너 내부 포함).
  호스트엔 GPU 드라이버만 있으면 됨. (DLAMI엔 드라이버 사전 포함)
- Vulkan ICD(`/usr/share/vulkan/icd.d/nvidia_icd.json`)는 드라이버가 설치. `vulkaninfo --summary`로 검증.
- Kit은 headless여도 X 서버(DISPLAY) 필요 → DCV 가상 세션 또는 Xvfb.

④ Kit 런타임 라이브러리 (minimal Ubuntu에서 자주 누락 → Kit 미기동 주범):

```bash
libvulkan1 vulkan-tools \
libgl1-mesa-glx libgl1 libgles2 libegl1 libglx0 \
libx11-6 libxext6 libxrandr2 libxcursor1 libxi6 libxinerama1 libxss1 \
libgomp1 libglu1-mesa \
fontconfig fonts-liberation \
libasound2 libpulse0 libatomic1
```

⑤ DCV(헤드리스 GPU 렌더) 핵심: `nvidia-xconfig --preserve-busid --enable-all-gpus`로
모니터 없이도 GPU에 바인딩되는 Xorg 구성 생성 → DCV GL(`nice-dcv-gl`, 신버전 `amazon-dcv-gl`)이 OpenGL/GLX를 GPU로 라우팅.
(상세 절차는 5-1·6 참고)

⑥ Python 환경 — 두 종류를 구분 (대부분 자동, 하나만 시스템 설치 필요):

| 용도 | Python 출처 | 시스템 설치 |
|------|-------------|:----------:|
| Kit 익스텐션(Python) | Kit 내장 Python 3.12 (번들) | 불필요 |
| kit-app-template 빌드(repo.sh) | packman이 Python 3.12 자동 다운로드 | 불필요 |
| usd-convert-cad CLI (CAD→USD) | venv (`python3.12 -m venv`) | 필요(3.12) |
| 독립 USD 스크립팅 (`pip install usd-core`) | venv | 필요(3.12) |

- ⚠️ Ubuntu 22.04 기본 Python은 3.10인데, usd-convert-cad는 정확히 3.12 요구
  → deadsnakes PPA로 3.12 설치 (또는 `uv`/`pyenv`):

  ```bash
  sudo add-apt-repository ppa:deadsnakes/ppa
  sudo apt update
  sudo apt install -y python3.12 python3.12-venv python3.12-dev
  ```

- usd-convert-cad: `python3.12 install.py` → `.venv` 생성 + `omniverse-kit`(pypi.nvidia.com)
  설치. 헤드리스 실행 시 `OMNI_KIT_ACCEPT_EULA=yes` 필요.
- usd-core(독립 USD 조작): `python3.12 -m venv .venv && pip install usd-core` (pxr 바인딩).
- NVIDIA 권장: conda는 실험적 지원이라 비권장. Kit은 내장 Python, 그 외는 표준 venv 사용.

Kit 미기동 시 진단 체크리스트:

```bash
vulkaninfo --summary            # NVIDIA Vulkan ICD 로드 확인
ldconfig -p | grep -E "libGL|libvulkan|libX11"   # GL/Vulkan/X11 존재 확인
echo $DISPLAY                   # 디스플레이 설정 확인
ls /usr/share/vulkan/icd.d/nvidia_icd.json       # ICD 파일 존재 확인
```

### 5-1. 부트스트랩 자동화 범위 (UserData / SSM)

베이스 AMI = DL Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04) 기준.
드라이버/CUDA가 사전 포함되어 있어, 아래 설치 명령은 "DLAMI 미사용/순정 Ubuntu"
시나리오를 위한 참고이며 DLAMI에서는 버전 확인·검증 위주로 단순화한다.

1. (계층①) 드라이버 검증: `nvidia-smi` 동작 확인. DLAMI는 사전설치라 보통 검증만.
   - 권장 드라이버 580 브랜치(580.65↑). 순정 Ubuntu 시 NVIDIA apt repo로 설치:

     ```bash
     sudo apt update
     sudo apt install -y linux-headers-$(uname -r) nvidia-driver-580
     # 주의: 본 절차의 'aws-nvidia-grid-driver'는 g5용 예시 → g6e/g7e엔 부적합
     # CUDA Toolkit은 호스트에 불필요 (Kit 자체 번들, NIM은 컨테이너 내부 포함)
     ```

2. (계층④) Kit 런타임 라이브러리 설치 — Kit GUI 구동의 누락 주범 (5-0 목록)
3. (계층⑤) Amazon DCV 서버 + DCV GL(`nice-dcv-gl`/`amazon-dcv-gl`) 설치, NVIDIA Xorg 구성,
   `dcvserver` enable/start (섹션 6)
4. (계층②, `installNim`=on 시) Docker CE + nvidia-container-toolkit 설치/런타임 구성 (5-3)
5. DCV 접속 계정 비밀번호를 Secrets Manager에서 조회해 설정 (섹션 6)
6. 모델 캐시 디렉터리(`/opt/nim/cache`) 등 기본 디렉터리 생성 (루트 볼륨 내)
7. 부트스트랩 로그를 CloudWatch로 전송, 완료 시그널
   (계층③ Kit 빌드 도구 + kit-app-template는 DCV 접속 후 수동: 5-2)

### 5-2. Omniverse 앱 / 라이선스 — 권장 방식 (Kit 기반)

EOL된 Omniverse Launcher 방식은 사용하지 않는다.
2026년 현행 권장 경로 = Kit 기반 앱(kit-app-template) 직접 빌드/실행.

DCV로 GUI 접속 후 수동 진행 (실배포 검증 절차):

```bash
cd ~
git clone https://github.com/NVIDIA-Omniverse/kit-app-template.git
cd kit-app-template
./repo.sh template new     # (최초 1회) packman이 Python 3.12 자동 다운로드
                           # → 대화형 메뉴: Application → 템플릿(Kit Base Editor/
                           #   USD Composer 등) → 앱 이름 선택
./repo.sh build            # 익스텐션·의존성 자동 다운로드 + 빌드 (수 분~십수 분)
./repo.sh launch           # 앱 실행 → DCV 화면에 3D 뷰포트 GUI
```

- ⚠️ 대화형 강제: `repo.sh template new`는 앱 종류/이름을 대화형 메뉴로 받는다
  (비대화형 인자 없음 → SSM/스크립트 자동화 불가). 반드시 DCV GUI 터미널에서 직접 실행.
  실배포 검증에서 확인: clone + packman(Python 3.12) 부트스트랩까지는 정상, 그 다음
  `template new`가 EOFError(비대화형)로 막힘 → 사람이 DCV에서 메뉴 선택해야 진행됨.
- 라이선스: BYOL → 고객 보유 라이선스. 필요 시 DLS(Delegated License Service)
  서버에 연결 (Enterprise 사용 시). 연구용 무료 라이선스 경로도 고객 확인.
- Nucleus 협업 서버는 필요 시 별도 구성 (현행 배포 방식 확인)

> kit-app-template 클론/빌드는 사용자가 DCV 접속 후 수동 진행 (CDK/UserData 범위 외).
> 부트스트랩은 GPU 드라이버·DCV·(옵션)NIM 런타임 + Kit 런타임 라이브러리까지 제공.
> 설치 구성요소 확인 명령은 README "배포 후 검증" 섹션 참고.

> ✅ 실배포 검증 완료(2026-05-30, g7e.4xlarge/RTX PRO 6000, 서울): USD Composer
> 템플릿 생성→build→launch로 RTX 렌더러 구동 확인 (DCV 화면에 3D 뷰포트, FPS 228).
> 첫 실행 "RTX Loading"은 셰이더 컴파일(수 분, CPU 바운드, GPU 크기 무관) → 완료 후
> RTX Real-Time 228fps 정상 렌더. 스크린샷: README "검증 완료 화면"
> (docs/images/usd-composer-rtx-loading.png, usd-composer-rtx-running.png).

### 5-3. Omniverse NIM 컨테이너 설치 (권장 경로의 핵심)

NIM 마이크로서비스는 컨테이너로 배포한다 (현행 권장 방식). 부트스트랩에서 자동화.

1. Docker + NVIDIA Container Toolkit 설치/런타임 설정
2. NGC API Key 주입 (Secrets Manager 조회) → `nvcr.io` 로그인
3. 대상 NIM 컨테이너 pull (이미지/태그 파라미터화)
4. 컨테이너 실행 (`--gpus all`, 포트 매핑, 모델 캐시 볼륨 `/opt/nim/cache` 마운트)
5. 헬스체크

- 부트스트랩 자동화 포함 여부는 플래그(`installNim`)로 on/off
- ⚠️ VRAM 공유 주의: g6e.4xlarge = L40S 48GB 단일 GPU.
  Kit 앱(USD Composer 등) + NIM 모델이 같은 48GB를 공유한다.
  - 가벼운 NIM은 공존 가능. 대형/다중 NIM은 VRAM 부족 가능 → 모델 크기 확인 또는
    인스턴스 상향(g6e.12xlarge, L40S x4) 검토
- 어떤 NIM을 쓸지는 미정 (섹션 11 고객 질의 항목)

#### 멀티 GPU 환경 — GPU 분리 가이드 (g7e.12xlarge / g6e.12xlarge)

단일 GPU(g7e.4xlarge, 96GB)는 NIM(~40GB)+Kit(~15GB) 공존 OK라 PoC엔 충분.
멀티 GPU 인스턴스에선 워크로드를 GPU별로 분리하면 경합을 없앨 수 있다
(Blueprint standard의 Kit=GPU0 / NIM=GPU1 분리와 동일 개념).

> ⚠️ 현재 CDK/부트스트랩은 단일 GPU 기준(NIM `--gpus all`). 아래는 멀티 GPU
> 인스턴스에서 수동으로 분리하는 가이드. 코드 옵션화(`nimGpuDevice`/`kitGpuDevice`)는 향후 과제.

| 항목 | 현재(단일 GPU) | 멀티 GPU 분리 |
|------|----------------|---------------|
| NIM 컨테이너 | `docker run --gpus all` | `docker run --gpus '"device=1"'` (GPU1 전용) |
| Kit 앱 | GPU 자동 | `CUDA_VISIBLE_DEVICES=0` 실행 (GPU0 전용) |
| (옵션) 파라미터 | 없음 | `nimGpuDevice=1`, `kitGpuDevice=0` 도입 시 자동 분리 |

수동 적용 예 (g7e.12xlarge, GPU 2개):

```bash
# NIM을 GPU 1에만
docker run -d --restart unless-stopped --gpus '"device=1"' \
  -e NGC_API_KEY="$NGC_KEY" -p 8000:8000 \
  -v /opt/nim/cache:/opt/nim/.cache --name nim <NIM_IMAGE>

# Kit을 GPU 0에만 (livestream도 동일)
CUDA_VISIBLE_DEVICES=0 ./<app>.kit.sh ...
```

- 확인: `nvidia-smi`의 GPU별 프로세스/메모리로 NIM·Kit이 서로 다른 GPU에 붙었는지 검증.
- g6e.12xlarge(L40S 48GB ×4): NIM(~40GB)이 한 GPU(48GB)에 빠듯 → GPU 분리 필수.
  여유 있는 g7e.12xlarge(96GB ×2)가 더 안전.

#### 향후 프로덕션 NIM 배포 — NVIDIA 권장 경로 (참고)

본 PoC는 단일 EC2에 컨테이너를 직접 실행(`docker run`)하는 방식으로, 검증·데모에
최적화된 가장 단순한 형태다. 프로덕션 운영(고가용성·오토스케일·다중 사용자)으로
넘어갈 때는 NVIDIA 공식 문서가 권장하는 AWS 관리형 배포로 전환하는 것이 좋다.

NVIDIA NIM on AWS 두 가지 권장 경로
(출처: https://docs.nvidia.com/nim/large-language-models/latest/deployment/csp-deployment/aws.html):

| 경로 | 방식 | 적합 상황 |
|------|------|-----------|
| Amazon EKS | Kubernetes + Helm 차트, NVIDIA GPU Operator, EBS CSI(모델 캐시 PVC), LoadBalancer | 자체 운영 K8s 선호, 세밀한 오토스케일·롤링 업데이트 필요 |
| Amazon SageMaker | NIM 네이티브 BYOC(포트 8080, `/ping`·`/invocations`), 모델 S3 저장 | 완전관리형 엔드포인트, K8s 운영 부담 회피 |

- 두 경로 모두 GPU 쿼터 사전 확인, NGC Key 등 시크릿의 안전 관리(K8s Secrets/IAM),
  모델 아티팩트 영속 저장(재시작 간 캐시 재사용), 헬스 엔드포인트 모니터링을 베스트
  프랙티스로 제시한다.
- 본 PoC의 단일 EC2 방식은 이 둘로 가기 전 "NIM+Kit 파이프라인이 동작함"을 빠르게
  검증하는 단계 → 프로덕션 결정 시 EKS/SageMaker로 이관 권장.

#### (옵션) Open WebUI 연동 — NIM 동작 확인용 셀프호스팅 챗봇 UI

LLM 계열 NIM(OpenAI 호환 `/v1` API 제공)을 띄운 경우, Open WebUI로 브라우저에서
바로 추론을 확인할 수 있다. NIM 엔드포인트가 살아있는지 빠르게 검증하는 용도.

```bash
docker run -d -p 3000:8080 \
  -e OPENAI_API_BASE_URL=http://<NIM_HOST>:8000/v1 \
  -e OPENAI_API_KEY=none \
  ghcr.io/open-webui/open-webui:main
# 브라우저에서 http://localhost:3000 접속 (원격 시 DCV/포트포워딩 경유)
```

- ⚠️ 본 CAE PoC의 CFD NIM(DoMINO-Automotive-Aero)은 챗 LLM이 아니라 형상→물리량
  추론 모델 → Open WebUI 대상이 아니다. Kit-CAE가 직접 추론 API를 호출한다(섹션 0-3).
  Open WebUI는 USD Code 등 LLM형 NIM을 함께 띄워 별도 검증할 때만 유용.
- PoC 기본 범위 밖(부트스트랩 미포함). 필요 시 DCV 접속 후 수동 실행.
- 3000 포트를 외부 노출하려면 SG/`allowedCidr` 별도 검토 (기본은 비노출).

### 5-4. 디지털 트윈 CAD 파이프라인 (지멘스 NX → USD)

산업 설비 트윈의 출발점 = CAD 데이터를 USD로 가져오기.
고객 CAD는 지멘스 NX(.prt) 기준.

CAD Converter는 별도 apt 패키지가 아니라 Kit 익스텐션이다 (자동 다운로드):

| 사용 방식 | CAD Converter |
|-----------|---------------|
| USD Composer 앱 | 기본 포함(default 활성화). 추가 설치 불필요 |
| kit-app-template 빌드 | 익스텐션 의존성으로 추가 → 레지스트리에서 자동 다운로드 |
| headless CLI(`usd-convert-cad`) | 첫 변환 시 자동 다운로드 |

- NX `.prt`는 추가 라이선스 없이 변환 가능. NVIDIA가 변환 엔진(HOOPS Exchange)을
  익스텐션에 내장(라이선스 부담). 관련 익스텐션: `omni.kit.converter.cad`,
  `omni.kit.converter.hoops_core`(STEP/IGES/NX/CATIA 등), `omni.kit.converter.jt_core`(JT).
  (CATIA/SolidWorks/Revit 등 일부 포맷만 추가 라이선스 가능성 — NX는 해당 없음)

권장 변환 경로:
- Path B(권장): NX → JT 내보내기 → USD. 지멘스 공식 경로(Teamcenter Digital Reality
  Viewer 방식). 어셈블리 계층·PMI·재질 메타데이터 보존 최상.
- Path A(간편): NX `.prt` 직접 변환. 단 대형 어셈블리는 외부 참조 파일이 동일 경로에
  모두 있어야 함(Nucleus 클라우드 경로의 외부참조 어셈블리는 미지원 → 로컬 변환).
- Path C(폴백): NX → STEP → USD. 중립 포맷이나 메타데이터/PMI 손실.

전 과정 Ubuntu 22.04에서 동작 → 변환 서버에 NX 설치 불필요.
NX는 엔지니어가 .prt/JT를 만드는 작업용으로만 필요(이미 보유, Windows/RHEL).

대형 설비 스케일(수백만 파트):
- 서브어셈블리(데크/존 단위) 분할 변환 → USD Payload로 합성(지연 로딩).
- 변환 시 `tessLOD` 낮춤, 인스턴싱 활성화(반복 파트=볼트/플랜지/파이프 메모리 절감),
  Scene Optimizer로 히든 메시 제거·디시메이션.
- 변환 병목은 주로 RAM(HOOPS가 전체 어셈블리를 메모리 로드) → 분할 변환으로 완화.
- (선택) 기존 설비는 레이저 스캔 점군(E57/PTS)을 같은 USD 스테이지에 합성.

> ⚠️ 외부 트래픽 차단 금지 (가장 중요한 함정 — 온프렘 실패 원인과 동일):
> CAD Converter 등 Kit 익스텐션은 NVIDIA 레지스트리에서 다운로드된다. 사내 폐쇄망/
> 랜딩존에서 외부 트래픽을 막으면 Kit/CAD 변환이 동작하지 않는다.
> 최소 허용 도메인(아웃바운드 443):
>   - `pypi.nvidia.com` (Kit/익스텐션 패키지)
>   - Kit 익스텐션 레지스트리 / `*.nvidia.com`
>   - `nvcr.io` + NGC CDN (NIM/컨테이너 이미지)
>   - Ubuntu/Docker apt 미러 (OS 패키지)
> 폐쇄망이 불가피하면 사전 미러링(사내 ECR/PyPI 미러/오프라인 번들) 필요 → 섹션 3 참고.

---

## 6. DCV (Amazon DCV, 구 NICE DCV) 설치 및 비밀번호 관리

- DCV 서버 패키지 설치 (Ubuntu 22.04용)
- GPU 가속 가상 세션 구성, 포트 8443(HTTPS)
- DCV 접속 계정 비밀번호:
  - AWS Secrets Manager에 시크릿 생성 (CDK가 생성, 랜덤 생성 옵션)
  - 인스턴스 IAM Role에 해당 시크릿 `GetSecretValue` 권한 부여
  - UserData에서 시크릿 조회 후 OS 사용자 비밀번호 설정
- DCV 라이선스: AWS EC2(G/GR 계열)에서 추가 라이선스 비용 없이 사용 가능 확인
- TLS 인증서 (8443 HTTPS):
  - 기본: DCV 자동 생성 self-signed → 접속은 되나 브라우저 경고. 검증/데모 단계엔 충분
    (접근은 `allowedCidr` + DCV 비번으로 별도 보호).
  - 옵션: 사내 CA 발급 인증서를 Secrets Manager(`{"cert","key"}`)에 저장 →
    `dcvCertSecretArn` 파라미터로 주입, 부팅 시 `/etc/dcv/`에 배치 후 dcvserver 재시작.
  - ⚠️ ACM 인증서는 ALB/NLB/CloudFront에만 부착 가능(EC2 직접 불가). 본 PoC는 고정 IP
    직접 접속이라 ACM 미사용 → self-signed 또는 사내 CA 주입 방식.

---

## 7. SSH 접속

- EC2 Key Pair: 기존 키페어 이름을 파라미터로 받거나 CDK에서 신규 생성
- 관리자 사용자: `ubuntu`
- `private`: SSH는 VPN/DX 너머 사내망에서 사설 IP로 접속
  `public`(테스트): EIP 공인 IP로 SSH 접속 (소스는 `allowedCidr` /32 권장)
- SSM Session Manager 병행 권장 — 키/인바운드 22 없이 접근 가능, 보안 강화
  (프라이빗 인스턴스 관리에 적합. SSM VPC Endpoint 또는 NAT 경로 필요)
- SSH 허용 CIDR은 위 `allowedCidr` 파라미터 공유 (사내망 대역, 개방 금지)

### 작업 환경: DCV + 터미널로 충분 (code-server 미포함)

이 PoC는 "설치/구동 검증"이 목적이므로 별도 웹 IDE(code-server)는 넣지 않는다.

| 작업 | 도구 |
|------|------|
| 부트스트랩/설치/디버깅, docker, NIM 로그 | SSH / DCV 터미널 (CLI) |
| kit-app-template 빌드 (`./repo.sh build`) | DCV 터미널 (CLI) |
| Kit 앱 GUI 구동 (USD Composer 등) | DCV (필수, 3D 렌더링) |
| 설정/스크립트 편집 | vim/nano 또는 DCV 데스크톱 GUI 에디터 |

- Kit GUI는 어차피 DCV가 필수이고, 빌드/실행/디버깅은 전부 CLI로 처리됨.
- DCV에 데스크톱 환경(ubuntu-desktop)이 포함 → GUI 터미널·파일매니저·에디터 제공.
- code-server가 필요해지는 경우(이 PoC 범위 밖): Kit 익스텐션 본격 개발(대량 Python
  코딩/디버거), 또는 DCV 차단·웹 IDE만 허용하는 사내 정책.
  → 필요 시 옵션 플래그(`installCodeServer`)로만 추가, 기본은 미설치.

### 파일 업로드 / 다운로드

code-server 없이도 파일 전송은 불편하지 않다. 용도별 방법:

| 방법 | 용도 | 비고 |
|------|------|------|
| DCV 내장 파일 전송 | 소~중 파일 업/다운 | DCV의 Storage 메뉴/드래그앤드롭. 별도 설정 불필요 |
| DCV 클립보드 공유 | 스크립트/설정 텍스트 복붙 | 로컬↔원격 양방향 |
| SCP / SFTP (SSH) | 반복 전송·자동화 | `scp file ubuntu@사설IP:/path` |
| S3 경유 (권장, 대용량) | 모델/USD 에셋 수십 GB | `aws s3 cp`, 인스턴스 IAM Role 권한 |
| git / git-lfs | 코드·kit-app-template | 이미 설치됨(계층③) |

- DCV 자체에 GUI 파일 업/다운로드가 내장 → 일반 PoC 작업엔 충분.
- 대용량(모델 가중치/에셋)은 DCV/SCP보다 S3가 빠르고 안정적.
- 프라이빗 서브넷이므로 S3는 S3 VPC Endpoint(Gateway형, 무료) 경유 권장
  → 인터넷 거치지 않고 빠르게 전송, 사내 보안정책에도 부합. (IAM에 S3 권한 추가)

---

## 8. IAM

EC2 인스턴스 프로파일(Role)에 부여할 정책. 최소 권한 원칙 적용.

| 권한 | 용도 | 부여 방식 |
|------|------|-----------|
| S3 읽기/쓰기 (지정 버킷) | 모델/USD 에셋 업·다운로드 (파일 전송 주 경로) | 인라인 정책, 버킷 ARN 한정 |
| ECR 읽기/쓰기 | 사내 ECR로 NIM/Kit 이미지 미러링·pull·push | `ecr:GetAuthorizationToken` + pull/push 액션 |
| SSM (Session Manager 접근) | SSM Agent로 키 없이 EC2 접근/명령 | `AmazonSSMManagedInstanceCore` 관리형 |
| Secrets Manager 읽기 | DCV 비밀번호, NGC API Key 조회 | 인라인, 해당 시크릿 ARN 한정 |
| CloudWatch Logs 쓰기 | 부트스트랩/시스템 로그 전송 | `CloudWatchAgentServerPolicy` 또는 인라인 |
| KMS Decrypt | EBS·시크릿 암호화 키 복호화 | 해당 KMS 키 한정 (CMK 사용 시) |

### S3 읽기/쓰기 권한 상세
- 대상 버킷을 파라미터(`assetBucketName`)로 받아 해당 버킷 ARN으로만 제한.
- 액션: `s3:GetObject` `s3:PutObject` `s3:ListBucket` `s3:DeleteObject`(필요 시).
- S3 VPC Endpoint(Gateway형) 사용 시 엔드포인트 정책과 함께 이중 제한 가능.

### ECR 읽기/쓰기 권한 상세
- 사내에서 NIM/Kit 컨테이너 이미지를 ECR로 미러링·관리하는 경우 사용.
- 로그인: `ecr:GetAuthorizationToken` (리소스 `*` 필요 — 토큰 발급용).
- pull: `ecr:BatchGetImage` `ecr:GetDownloadUrlForLayer` `ecr:BatchCheckLayerAvailability`.
- push: `ecr:PutImage` `ecr:InitiateLayerUpload` `ecr:UploadLayerPart`
  `ecr:CompleteLayerUpload`.
- 대상 리포지토리 ARN으로 제한 (GetAuthorizationToken만 `*`, 나머지는 repo ARN 한정).
- 프라이빗 서브넷 → ECR VPC Endpoint(ecr.api/ecr.dkr) + S3 Endpoint(레이어 저장소)
  또는 NAT 경로 필요.

### SSM 접근 권한 상세
- `AmazonSSMManagedInstanceCore` 부여 → Session Manager로 인바운드 22 없이 접근.
- 프라이빗 서브넷이므로 SSM VPC Endpoint(ssm/ssmmessages/ec2messages) 또는
  NAT 경로 중 하나 필요.
- SSH 키 분실/사내정책상 22 차단 시에도 SSM으로 안전하게 관리.

### CloudWatch 메트릭 권한 (모니터링 포함 → 필수)
- `cloudwatch:PutMetricData` — CloudWatch agent가 GPU 사용률/VRAM 커스텀 메트릭 전송.
- `AmazonCloudWatchAgentServerPolicy` 관리형으로 일괄 부여 가능.

### 그 외 검토한 정책 (현재 PoC 범위 판단)
- EC2 태그/메타데이터 읽기: 부트스트랩이 자기 태그 참조 시에만 (보통 불필요).
- 기본 미포함, 필요 발생 시 추가 (최소 권한 유지).

---

## 8-1. 운영 / 안정성

### 백업 — 설치 완료 후 AMI 생성
- 드라이버·DCV·Kit 런타임 라이브러리·(NIM 런타임)까지 설치된 상태를 골든 AMI로 생성.
- 효과: 재구축/추가 인스턴스 기동이 부팅 수 분으로 단축, 온프렘식 설치 삽질 반복 방지.
- 방식: 최초 부트스트랩 완료 후 수동 또는 SSM Automation(`CreateImage`)으로 생성.
- 골든 AMI ID를 파라미터(`baseAmiId`)로 받아 이후 배포는 이 AMI에서 빠르게 기동.
- 주의: AMI에는 시크릿/개인 데이터가 포함되지 않도록(부팅 시 주입 유지).

### 모니터링 — CloudWatch agent + GPU 메트릭
- CloudWatch agent 설치, GPU 사용률/VRAM/온도(nvidia-smi 또는 DCGM exporter) 수집.
- 시스템 로그·부트스트랩 로그도 CloudWatch Logs로 전송 (실패 가시성).
- 용도: PoC 성능 병목 파악, VRAM 부족(Kit+NIM 공존) 진단 → 인스턴스 상향 판단 근거.

### 부트스트랩 성공/실패 가시성
- UserData가 조용히 실패하면 디버깅 곤란 → 명시적 신호 필요.
- `cfn-signal`(또는 CloudFormation `CreationPolicy`)로 부팅 성공/실패를 스택에 보고.
- 각 설치 단계 로그를 `/var/log/omniverse-bootstrap.log` + CloudWatch Logs로 이중 기록.

### 시작/중지 — 수동 관리
- 자동 스케줄링(EventBridge stop/start)은 미적용. 사용자가 직접 stop/start.
- 비용 주의: g7e.12x는 시간당 약 $10 → 미사용 시 반드시 stop 권장 (문서/안내로 강조).
- (향후) 비용 이슈 시 EventBridge 야간/주말 자동 stop 옵션 추가 검토.

### 용량 사전 확보 (g7e capacity 빠듯 — 실측)

- 서울 g7e.4xlarge 가용분 ~5대 수준, g7e.12xlarge 거의 0 (섹션 0-2). 일정 확정 시
  데모 전에 1대 미리 기동 → stop 유지로 확보 권장.
- 단, stop 상태는 capacity 예약이 아니라 start가 거절될 수 있음 → 확실히 잡으려면
  ODCR(On-Demand Capacity Reservation)로 해당 AZ·타입을 데모 기간만 예약 후 해제.
- 폴백 순서: g7e.4xl → g7e.12xl → g6e.12xl. `instanceType` 파라미터로 즉시 전환 가능.

### 태깅
- 비용 추적/정리용 공통 태그: `Project`, `Owner`, `Environment=poc`, `ManagedBy=cdk`.

### cdk-nag (보안 자동 점검)
- 합성(synth) 시 cdk-nag(AwsSolutions 룰셋)로 보안 베스트프랙티스 자동 검사.
- 의도적 예외는 `NagSuppressions`로 사유와 함께 명시 (무음 무시 금지).

---

## 9. 비용 안내 (서울 리전 ap-northeast-2, Linux 온디맨드)

인스턴스 단가는 2026-05-29 Pricing API 조회값 (온디맨드, 공유 테넌시).

| 항목 | 시간당 | 비고 |
|------|--------|------|
| g7e.4xlarge (기본) | $4.916 | RTX PRO 6000 96GB ×1 |
| g7e.12xlarge | $10.187 | RTX PRO 6000 96GB ×2 |
| g6e.4xlarge | $3.694 | L40S 48GB ×1 |
| g6e.12xlarge | $12.900 | L40S 48GB ×4 |
| EBS gp3 500GB (루트, 통합) | 월 약 $40 | 용량 기준 (OS+캐시 통합) |
| 데이터 전송(아웃) | 사용량 기반 | - |
| NAT Gateway | 시간당 + 처리량 요금 | NGC pull 등 아웃바운드용 |

- 비용 절감: 미사용 시 인스턴스 중지(stop), 스팟 인스턴스 옵션 검토
- 테스트 용도는 NGC 무료 키로 NIM 사용 가능 → 추가 라이선스 비용 없음
  (프로덕션 운영 시에만 NVIDIA AI Enterprise 구독 비용 별도). 상세는 섹션 9-1 참고
- 정확한 단가는 배포 리전/시점 기준으로 재확인 필요

---

## 9-1. 라이선스 / 인증 (테스트 용도 기준)

이 프로젝트는 테스트/프로토타이핑 목적이며, 정식 유료 라이선스 키를 입력하는 절차는 없다.
구성요소별 정리:

| 구성요소 | 테스트 시 필요한 것 | 비고 |
|----------|---------------------|------|
| Omniverse Kit / kit-app-template | 없음 (무료) | Kit SDK 상당 부분 오픈소스(Apache 2.0). 라이선스 키 입력 불필요 |
| Omniverse NIM 컨테이너 | NGC API Key (무료) | NVIDIA Developer Program 무료 가입 → 개발/테스트용 NIM 무료 접근. "라이선스 비용"이 아니라 인증 토큰 |
| Amazon DCV (구 NICE DCV) | 없음 | EC2 G/GR 계열에서 추가 라이선스 비용 없이 사용 |
| NVIDIA AI Enterprise | 테스트 불필요 (프로덕션만) | 상용/프로덕션 운영 시에만 유료 라이선스 필요 |

주의사항:
- 입력/준비가 실제 필요한 것은 NGC API Key 하나 (Secrets Manager로 관리).
- 일부 NIM 모델은 early access 권한이 별도로 걸려 있을 수 있음 → 배포 전 해당
  NIM 모델 페이지에서 접근 가능 여부 확인.
- NVIDIA 라이선스 약관은 변동되므로 배포 시점에 최신 정책 재확인 권장.

### NGC API Key 획득 방법

NIM 컨테이너 pull에 필요한 인증 토큰. 고객/SA가 본인 NGC 계정으로 직접 발급한다
(공유 불가). 발급 후 Secrets Manager에 저장 → 부팅 시 주입 (섹션 6).

1. https://ngc.nvidia.com 접속
2. 계정 생성
   - "Sign Up" 클릭 → 이메일(회사 이메일 권장)·이름·비밀번호 입력 → 이메일 인증 완료
3. API Key 생성
   - 로그인 후 우측 상단 프로필 아이콘 → "Setup" → "Generate API Key"
   - "Generate Personal Key" 클릭 → 키 복사 (한 번만 표시되므로 반드시 저장)
4. 확인 (로컬에서 사전 검증 시):

   ```bash
   docker login nvcr.io
   # Username: $oauthtoken
   # Password: <발급받은 API Key>
   ```

- 무료 계정으로 NIM 컨테이너 pull 가능 (NVAIE 불필요).
- API Key는 `nvapi-` 로 시작.
- 고객 안내: 키는 본인 NGC 계정으로 직접 발급해야 하며 공유 불가.
  본 PoC에서는 발급된 키를 Secrets Manager에 저장 → UserData가 조회해
  `docker login nvcr.io` 자동 수행 (섹션 5-3).

---

## 10. 사전 준비물 (Prerequisites)

### 배포 머신에 사전 설치 (CDK 배포 실행 환경)

배포를 실행하는 로컬 PC/서버에 아래 도구가 설치되어 있어야 한다.

| 도구 | 버전 | 용도 |
|------|------|------|
| AWS CLI | v2 | AWS 인증/조회 |
| Node.js / npm | >=18 LTS | CDK(TypeScript) 런타임 |
| AWS CDK | v2 (2.1118+) | 인프라 배포 |
| (옵션) Docker | 최신 | CDK 에셋 번들링 시에만 (기본 불필요) |

- TypeScript 채택 → Node.js/npm 필수, Python 불필요.
- Docker는 본 스택이 컨테이너 이미지를 로컬 빌드하지 않으므로 기본 불필요(옵션).
- 확인: `aws --version` / `node --version` / `cdk --version` / `npm install`.
- 최초 1회 `cdk bootstrap aws://<account>/ap-northeast-2`.

### AWS 계정 / 권한

- AWS 계정 + 자격증명
  - 일반 사용자: `aws configure` 또는 `aws sso login` → `AWS_PROFILE` 설정
  - Amazon 내부 직원(이 repo 개발 환경): `mwinit -o` → `AWS_PROFILE=claude-code`
- NGC API Key (NVIDIA NGC 계정) — NIM 컨테이너 pull용 (테스트는 무료 키로 충분)
- CDK bootstrap 완료된 환경
- (프로덕션만) NVIDIA AI Enterprise 라이선스 — 테스트 단계에서는 불필요

### vCPU 쿼터 (온디맨드, 서울 리전)

핵심: AWS GPU 쿼터는 인스턴스 개수가 아니라 vCPU 총합으로 관리된다.
g6e/g7e 4종 모두 동일 쿼터 "Running On-Demand G and VT instances"
(코드 `L-DB2E81BA`)를 공유한다.

각 타입 2개씩 동시 기동 시 필요 vCPU:

| 타입 | vCPU | ×2개 |
|------|------|------|
| g6e.4xlarge | 16 | 32 |
| g6e.12xlarge | 48 | 96 |
| g7e.4xlarge | 16 | 32 |
| g7e.12xlarge | 48 | 96 |
| 합계 | | 256 vCPU |

- 증설 목표값: 256 vCPU (`L-DB2E81BA`) → "4종 각 2개 동시"를 완전 충족
- Spot은 사용하지 않음 (온디맨드 전용). Spot 쿼터(`L-3819A6DF`)는 무관.
- 배포 대상 계정에서 `L-DB2E81BA` 현재값을 반드시 확인 후 부족분만 증설 요청.
  (신규/별도 계정은 G 쿼터가 0~낮게 시작하는 경우 많음)
- 주의: g7e는 신형이라 쿼터가 충분해도 일부 AZ에서 용량(capacity) 부족으로
  기동 거절될 수 있음 → 일정 확정 시 사전 기동 테스트 권장.

---

## 11. 미확정 / 확인 필요 (Open Questions)

고객에게 질의 예정 (확정 후 파라미터 반영):

- [ ] 배포할 Omniverse NIM 구체 종류 (USD Code / USD Search / Audio2Face 등)
      → 이미지명·노출 포트·필요 VRAM·스토리지 용량이 모두 여기에 종속
- [ ] 접속 허용 네트워크 대역 (`allowedCidr`) — 고객 사내망 CIDR
- [ ] 기존 VPC ID + 서브넷 ID (가용 az 2a/2b 모두 — capacity 폴백용 다중 입력), VPN/DX 연결됨
- [ ] NGC API Key 보유 여부 / 발급 주체 (고객 NGC 계정)
- [ ] 대상 NIM의 early access 권한 필요 여부
- [ ] 아웃바운드 경로: NAT Gateway 가능 여부 vs 사내 프록시 강제

기본값으로 진행 (고객 별도 요구 없으면 이대로):

- [x] 배포 구성 → 단일 인스턴스 (ASG/멀티 미사용)
- [x] 네트워크 노출 → `deploymentMode`로 분기. 운영=private(사내전용), 테스트=public(EIP).
      기본 private. `0.0.0.0/0` 금지 가드레일 적용
- [ ] 도메인/TLS 인증서 → 미적용(사설 IP + 포트 직접 접속)
- [ ] 스토리지 → 루트 단일 500GB gp3 기본 (대형/다중 NIM 시 상향 또는 데이터 볼륨 분리)
- [ ] gp3 vs io2 Block Express → gp3 (IO 병목 실측 시 승격)
- [ ] 인스턴스 EBS 대역폭 상한 → 배포 후 점검

확정 완료 (해결됨):

- [x] 배포 리전 → ap-northeast-2 (서울), az 2a/2b. 단 g7e.12xl 용량 거의 0(실측,
      배포 직전 재확인) → g7e.4xl 우선, 폴백 g6e.12xl (섹션 0-2)
- [x] 베이스 AMI → DL Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04), SSM 파라미터 조회
- [x] VPC → 기존(미리 생성된) VPC를 파라미터로 입력받아 사용 (신규 생성 안 함)
- [x] 허용 소스 CIDR 방식 → `allowedCidr` 파라미터 (값은 고객 질의)
- [x] kit-app-template → 수동 설치, CDK/UserData 범위 제외 (섹션 5-1)

---

## 11-1. 리소스 생성 병렬화 (설계 원칙)

CloudFormation/CDK는 의존성 그래프 기반으로 서로 의존하지 않는 리소스를 자동 병렬
생성한다. 따라서 핵심은 "불필요한 의존성을 만들지 않는 것". 아래 원칙을 지킨다.

원칙:
- 불필요한 `addDependency()` 금지. CDK가 참조(ref)로 추론한 의존성만 남긴다.
- 한 리소스 출력을 다른 리소스에 억지로 연결해 직렬화하지 않는다.
- 독립 리소스(시크릿/IAM/로그그룹/VPC Endpoint 등)는 EC2와 무관하게 동시 생성되게 둔다.
- 인스턴스 부팅 후(UserData) 설치 작업도 가능한 병렬화 (아래).

의존성 구조 (무엇이 병렬, 무엇이 직렬인가):

| 그룹 | 리소스 | 병렬 가능 여부 |
|------|--------|----------------|
| A (독립, 동시) | DCV 시크릿, NGC 시크릿, IAM Role/Policy, CloudWatch Log Group, KMS 참조 | 서로 독립 → 전부 동시 생성 |
| A (독립, 동시) | S3/SSM/ECR VPC Endpoint들 (기존 VPC에 부착) | 서로 독립 → 동시 |
| A (독립, 동시) | Security Group | 단독 생성 (규칙은 SG 생성 후) |
| B (A에 의존) | EC2 인스턴스 | IAM 프로파일·SG·시크릿 참조 → A 완료 후 |
| C (B에 의존) | EIP 미사용. 고정 프라이빗 IP는 인스턴스 속성 → 추가 직렬 없음 |

→ 사실상 A 그룹 전체가 병렬로 생성되고, EC2(B)만 그 뒤에 한 번 생성된다.
   직렬 구간을 EC2 1개로 최소화하는 것이 목표.

부팅 후(UserData) 설치 병렬화:
- 서로 독립인 설치 단계는 백그라운드 실행 후 `wait`로 취합:
  - 계층④ Kit 런타임 라이브러리 apt 설치
  - 계층② Docker + nvidia-container-toolkit 설치
  - (installNim 시) NIM 이미지 pull — 가장 오래 걸림, 가장 먼저 백그라운드 시작
- 직렬 필수: 드라이버 검증 → (그 후) DCV 구성 → Xorg/GL 검증.
- 오래 걸리는 이미지 pull을 부팅 초반에 백그라운드로 던져 다른 apt 작업과 겹치게 한다.

> 주의: 병렬화로 의존이 실제로 필요한 곳까지 끊으면 경합 발생.
> 예) nvidia-container-toolkit 런타임 설정은 Docker 설치 완료에 의존 → 직렬 유지.

---

## 12. 예상 프로젝트 구조 (구현 단계에서 확정)

```
nvidia-omniverse-cdk/
├── bin/
│   └── app.ts                 # CDK 앱 엔트리
├── lib/
│   ├── omniverse-nim-stack.ts # 메인 스택 (VPC/SG/EC2/IAM/Secrets)
│   └── user-data.ts           # 부트스트랩 스크립트 생성
├── scripts/
│   └── bootstrap.sh           # 드라이버/Docker/NIM/DCV 설치 스크립트
├── cdk.json
├── package.json
├── tsconfig.json
└── CLAUDE.md
```

---

## 13. 향후 과제 메모 (운영화 시 참고)

PoC는 완료(전 기능 실증). 아래는 운영/확장 단계에서 검토할 항목 — 지금은 불필요.

### 코드 옵션화 (현재 수동/문서 가이드만 있는 것)
- 멀티 GPU 분리: `nimGpuDevice`/`kitGpuDevice` 파라미터 → NIM `--gpus device=N`,
  Kit `CUDA_VISIBLE_DEVICES` 자동 적용 (현재 섹션 5-3 수동 가이드).
- 골든 AMI 자동 생성: 설치 완료 후 SSM Automation(`CreateImage`) 또는 별도 스택으로
  코드화 → 재배포/스케일아웃 가속 (현재 섹션 8-1 개념만).
- Blueprint 옵션(`installBlueprint`): prebuilt 이미지 경로 확보 시에만 의미
  (from-source 빌드는 urm.nvidia.com 사내 의존으로 외부 불가 — 섹션 0-1).

### aws-samples 참고점 (github.com/aws-samples/nvidia-omniverse-modular-solution-with-aws-cdk)
- 모듈 분리: Workstation / Fleet / Nucleus를 독립 스택(모듈)으로. 우리는 단일 스택 →
  Nucleus·다중 워크스테이션 추가 시 옵션 플래그보다 모듈 분리가 깔끔.
- 대화형/프리셋 배포: `cdk deploy -c ...` 파라미터가 많음 → 대화형 wrapper
  또는 프리셋(예: `--profile demo-public`)으로 사용성 개선.
- Route53 + ACM(도메인/TLS): 운영 전환 시 IP+self-signed 대신 도메인/신뢰 인증서.
  (PoC엔 과함 — 현재 IP 직접 접속이 맞음)

> 우리가 이미 앞선 부분(참고 불필요): NIM 추론 연동, DCV+WebRTC 병행, 보안 가드레일
> (0.0.0.0/0 차단), 멀티 AZ 폴백, CAD→USD, 실배포 end-to-end 검증.
