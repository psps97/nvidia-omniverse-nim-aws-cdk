#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { OmniverseNimStack } from '../lib/omniverse-nim-stack';
import { parseConfig } from '../lib/config';

const app = new cdk.App();

// CDK context(-c key=value) 또는 cdk.json 기본값에서 파라미터를 읽고 검증한다.
// 허용 목록 위반·0.0.0.0/0 등은 여기서 throw → 합성(synth) 단계에서 차단.
const config = parseConfig(app);

// 리전: 본 프로젝트는 서울(ap-northeast-2) 전용 (g7e az 2a/2b, DLAMI 등).
// 셸의 자격증명 기본 리전(예: us-west-2)에 끌려가지 않도록 서울을 명시 고정.
// 다른 리전 테스트가 꼭 필요하면 -c region=... 으로만 덮어쓴다.
const region = (app.node.tryGetContext('region') as string | undefined) ?? 'ap-northeast-2';

// 스택 이름. 같은 VPC에 2호기 이상을 독립 배포하려면 -c stackName=... 으로 다르게 준다.
// (기본값 그대로 재배포하면 기존 스택 업데이트 = 기존 EC2 교체 — 새 인스턴스가 아님)
const stackName =
  (app.node.tryGetContext('stackName') as string | undefined) ?? 'OmniverseNimStack';

new OmniverseNimStack(app, stackName, {
  config,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID,
    region,
  },
  description:
    'NVIDIA Omniverse (Kit/RTX) + NIM on GPU EC2 — Digital Twin PoC (single instance, BYOL)',
});

// cdk-nag(AwsSolutions 룰셋) — 합성 시 보안 베스트프랙티스 자동 점검.
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

app.synth();
