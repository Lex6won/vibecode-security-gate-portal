# 패키지 게이트 기록

## 목적

하네스는 패키지 사용을 금지하지 않는다.

새 npm 또는 PyPI 패키지를 추가하거나 버전을 바꾸기 전에
체커 게이트로 안전성 증거를 먼저 확인한다.

## 현재 상태

- 현재 포털 구현은 Node.js 내장 모듈만 사용한다.
- `package.json`의 `dependencies`, `devDependencies`는 비어 있다.
- 새 패키지를 추가할 때는 아래 기록을 먼저 남긴 뒤 설치한다.

## 기록 형식

| 날짜 | 생태계 | 패키지 | 버전 | 명령 | 결과 | 조치 |
|---|---|---|---|---|---|---|
| 2026-08-09 | npm | 없음 | - | - | 추가 패키지 없음 | 내장 모듈 유지 |
| 2026-08-09 | npm | busboy | 1.6.0 | `gvskb_gate.js check/install`, `npm audit --omit=dev --audit-level=high` | PASS (MONITOR), audit 0 vulnerabilities | 브라우저가 선택한 폴더·ZIP 파일을 이 PC의 로컬 검사 작업공간으로 스트리밍 전송하기 위한 multipart 파서. 경로·파일 수·총 용량 제한을 서버에서 검증. |

## npm 패키지 확인

```bash
node shared/enforcement/gvskb_gate.js check <package> --version <version>
node shared/enforcement/gvskb_gate.js install <package> --version <version>
```

## PyPI 패키지 확인

```bash
python shared/enforcement/gvskb_gate.py check <package> --ecosystem pypi --version <version>
python shared/enforcement/gvskb_gate.py install <package> --version <version>
```

## 설치 전 원칙

- 체커가 `block`이면 설치하지 않는다.
- `warn` 또는 `needs-review`이면 대체 패키지, 표준 라이브러리 구현,
  검토 요청 중 하나를 먼저 선택한다.
- 직접 `npm install`, `pip install`을 실행하면 하네스 우회로 기록한다.
