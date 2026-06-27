<!--
PerfectOne - SW Unit Design (File-based, Function-included) Template
Purpose: ASPICE SWE.3 + ISO 26262-6 oriented unit design template for VSCodeExt Stage 1/2 pipeline.
Template revision: v1.5 (2025-12-16) - PROPOSE 범위 확장/ID seed 선채움 정책 반영(내용 구조는 유지).
Rules for LLM fill:
- DO NOT rename or renumber IDs (REQ-*, INTF-*, ASSERT-*, TC-*).
- IDs (REQ/INTF/ASSERT/TC) and key columns may be pre-filled deterministically by the generator; KEEP them stable.
- Preserve ALL HTML markers: <!-- PERFECTONE:* --> (used by Stage 2 viewer/extractor).
- Keep tables in Markdown table format.
- Use TBD/TODO when information is missing; do not invent safety claims without evidence.
-->

---
schemaVersion: "unit-design-md/1.3"
tooling:
  producer: "PerfectOne VSCodeExt"
  command: "perfectone.generateUnitDoc"
unit:
  slug: "<unit_slug>"              # e.g., Source__foo
  sourceFile: "<rel/path/to/file>" # e.g., Source/foo.c
  language: "C/C++"
document:
  title: "<파일명> 단위 설계서"
  status: "DRAFT"                  # DRAFT | REVIEWED | BASELINED
  created: "<YYYY-MM-DD>"
  updated: "<YYYY-MM-DD>"
  authors:
    - name: "<작성자>"
      role: "Designer"
  reviewers:
    - name: "<검토자>"
      role: "Reviewer"
changeHistory:
  - date: "<YYYY-MM-DD>"
    version: "0.1"
    author: "**[USER_INPUT_REQUIRED]** <작성자>"
    summary: "초안 생성 (AI-assisted)"
    note: "Stage 2+에서는 저장/Accept/Reject 이벤트를 기반으로 변경이력을 자동 누적(=Change History Recorder)할 수 있다."
aiDisclaimer:
  enabled: true
  text: "본 문서는 AI가 생성한 초안일 수 있으며, 기능안전/품질 관점에서 반드시 리뷰·승인 후 사용해야 한다."
wordExport:
  enabled: true
  target: "docx"
  guidance:
    - "본 MD는 Word(docx)로 변환될 수 있다. 변환 시 제목/헤더는 유지되도록 Heading 레벨(##/###/####)을 고정한다."
    - "표는 Markdown 표 형식을 유지한다(복잡한 중첩 표 금지)."
    - "Stage2 파서용 HTML comment marker(<!-- PERFECTONE:* -->)는 MD에만 필요하며, docx 변환 시 사라져도 무방하다."
    - "권장 변환: pandoc (예: pandoc <unit>.md -o <unit>.docx). 스타일 고정이 필요하면 --reference-doc=<reference.docx>를 사용한다."
reviewModel:
  ssot: "md"
  # Stage1: LLM은 'PROPOSED' 블록을 생성(또는 업데이트)하고, 사용자는 Stage2(Webview/에디터)에서 Accept/Reject 한다.
  # Stage2: Accept/Reject 확정 시 status를 갱신(또는 wrapper 제거)하고, 변경이력(changeHistory)에 자동 기록한다.
  markers:
    user_input_required: "**[USER_INPUT_REQUIRED]**"
    user_review_required: "**[USER_REVIEW_REQUIRED]**"
    ai_proposed: "**[AI_PROPOSED]**"
  blockMarkers:
    proposed_begin: "<!-- PERFECTONE:PROPOSE id=\"<id>\" status=\"PROPOSED\" -->"
    proposed_end: "<!-- PERFECTONE:PROPOSE_END id=\"<id>\" -->"
  states: ["PROPOSED","ACCEPTED","REJECTED"]

  historyLog:
    enabled: true
    target: ".perfectone/docs/history.jsonl"
    guidance:
      - "선택 기능: 문서/TC/trace 변경 이벤트(저장/Accept/Reject/ID 재생성)를 JSONL로 기록하여 감사 추적(Audit Trail)에 활용한다."

---

# <파일명> 단위 설계서

> **문서 상태:** `{{document.status}}`  
> **마킹 규칙(작성/검토):**  
> - **[USER_INPUT_REQUIRED]**: LLM이 확정하기 어려우므로 사용자가 반드시 기입해야 함(예: ASIL, Safety Goal 근거, 외부 규격/정책 결정).  
> - **[USER_REVIEW_REQUIRED]**: LLM이 초안을 채울 수 있으나 사용자가 리뷰 후 승인해야 함(예: 요구 해석, 오류 처리 전략, 테스트 충분성).  
> - **[AI_PROPOSED]**: LLM이 생성한 “제안” 블록. Stage2 뷰어/에디터에서 **Accept/Reject** 버튼으로 상태를 확정한다.  
> - Stage2 파서/뷰어용 마커(`<!-- PERFECTONE:* -->`)는 **원본 MD에서만 SSOT로 유지**한다(Word 변환에서 소실되어도 무방).

> **주의:** {{aiDisclaimer.text}}

<!-- PERFECTONE:UNIT_META slug="<unit_slug>" source="<rel/path/to/file>" -->

## 0. 용어 / 약어
- **REQ**: Requirement (요구사항)  
- **INTF**: Interface (인터페이스: 전역변수/함수인자/리턴/외부함수/IO 경로)  
- **ASSERT**: Assertion/Check (런타임 검증식, 계약, 불변식, 범위 검증 등)  
- **TC**: Test Case (CSV에 정의되는 테스트 케이스)  
- **Coverage**: (예) Statement/Branch/MC/DC, 요구 수준은 프로젝트 정책/ASIL에 따름

---

## 1. 목적 / 범위 / 참조 (필수)

### 1.1 목적
- 이 파일(단위)의 상세 설계를 정의하여 **구현 및 단위 시험의 근거**로 사용한다.
- ASPICE SWE.3 및 ISO 26262-6 소프트웨어 단위 설계/검증 요구를 충족할 수 있도록, **인터페이스·동작·오류·추적성**을 명시한다.

### 1.2 범위
- 적용 단위: `<rel/path/to/file>`  
- 포함 대상:
  - 외부로 노출되는 함수(파일 인터페이스)
  - 내부 함수(static 포함) 및 내부 호출 구조
  - 전역/정적 데이터 및 외부 의존성(다른 모듈, OS/BSW, 라이브러리)
- 제외/가정:
  - (예) 하드웨어 상세, 시스템 수준 안전 분석 결과(별도 문서 참조)

### 1.3 참조 문서
| Ref ID | 문서/링크 | 버전 | 비고 |
|---|---|---|---|
| REF-1 | SW 요구사항 명세서 | <v> | REQ-ID 출처 |
| REF-2 | SW 아키텍처 설계서 | <v> | 컴포넌트/인터페이스 상위 정의 |
| REF-3 | Coding Guideline (MISRA 등) | <v> | 준수 규칙 |
| REF-4 | Unit Test Plan / Coverage Policy | <v> | 목표 커버리지/방법 |
| REF-5 | (선택) Safety Plan / SG/TSR | <v> | **[USER_INPUT_REQUIRED]** ASIL/근거 |
| REF-x | 기타 |  |  |

---

## 2. 컨텍스트 & 인터페이스 (필수)

> **의도:** SWE.3 수준에서 단위 시험이 가능하도록, 외부/내부 인터페이스를 “테스트 가능한 수준”으로 기술한다.

### 2.1 단위(파일) 역할 및 상위 컴포넌트 관계
- 상위 컴포넌트/모듈: `<컴포넌트명>`
- 책임(Responsibility): `<이 파일이 담당하는 기능/역할 요약>`
- 경계(Boundary):
  - 입력 경로: `<상위 모듈 호출/전역변수/ISR/큐/메시지 등>`
  - 출력 경로: `<리턴/전역변수/콜백/하드웨어 제어 요청 등>`

### 2.2 인터페이스 분류 규칙 (이 템플릿의 기준)
- **External Interface (EI)**: 다른 파일/모듈에서 호출 가능한 함수(헤더 노출, non-static), 혹은 외부에서 읽기/쓰기 가능한 전역 변수.
- **Internal Interface (II)**: `static` 함수, 파일 내부 전역/정적 변수, 내부 helper, 내부 상태 머신 변수.
- **Dependency Interface (DI)**: 외부 함수 호출(라이브러리/OS/BSW/다른 모듈), 외부 자원(파일/네트워크/디바이스), 하드웨어 추상층(HAL) 접근.
- **Test Seam (TS)**: 테스트를 위한 스텁/모킹 포인트(예: weak symbol, dependency injection, wrapper).

### 2.3 컨텍스트 다이어그램(텍스트 기반)
<!-- PERFECTONE:BLOCK_BEGIN id="CTX-1" kind="AI_PROPOSED" status="PROPOSED" -->
**[AI_PROPOSED]**
- 입력 → 처리 → 출력 흐름을 5~10줄로 요약(그림은 Stage2에서 링크로 대체 가능).
- (예)
  1) `<상위 모듈>`이 `foo_init()` 호출  
  2) `foo_init()`은 전역 설정값 `g_cfg`를 읽어 내부 상태 `s_state` 초기화  
  3) 이후 주기 함수 `foo_step(in)` 호출 시 입력 검증 후 알고리즘 수행  
  4) 결과를 `<출력 인터페이스>`에 기록 및 에러코드 리턴
<!-- PERFECTONE:BLOCK_END id="CTX-1" -->

### 2.4 인터페이스 상세 표 (필수)
> **작성 규칙:** “유효범위/단위/해상도/범위/기본값/주기/지연/ASIL 영향”을 가능한 한 채운다.  
> **ID 생성:** `INTF-<n>`은 **파일 단위 고유**. (Stage1 도구가 선할당 가능)

| INTF_ID | 분류(EI/II/DI/TS) | Source(입력 출처) | Target(도착) | Interface Name | Natural Name(자연어) | Type/Width | Unit | Resolution | Range/Validity | Default | Direction(In/Out/InOut) | Rate/Latency | Lifetime/Scope | ASIL impact | Rationale / Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| *(예시)* |  |  |  |  |  |  |  |  |  |  |  |  |  | **[USER_REVIEW_REQUIRED]** <ASIL 영향> |  |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| INTF-1 | EI | <caller/module> | this unit | <param/global> | <의미> | <type> |  |  |  |  | In |  |  |  |  |
| INTF-2 | DI | this unit | <dep> | <func/resource> | <의미> | <signature> |  |  |  |  | Out |  |  |  |  |
| INTF-3 | II | this unit | this unit | <static var> | <의미> | <type> |  |  |  | <init> | InOut |  | File |  |  |
| INTF-x | TS | test harness | this unit | <seam> | <의미> | <type> |  |  |  |  | In |  | Test |  |  |

### 2.5 외부 의존성(라이브러리/OS/BSW) 요약
| Dep ID | Type | Name | Purpose | Failure Mode | Handling Strategy | Stub/Mock Plan |
|---|---|---|---|---|---|---|
| DEP-1 | Function | <foo_bar()> | <목적> | <리턴/에러> | <처리> | <stub?> |
| DEP-2 | Resource | <EEPROM> | <목적> | <타임아웃> | <리커버리> | <sim?> |

---

## 3. 기능 개요 (필수)

### 3.1 기능 요약(Top-level behavior)
- 주요 기능:
  - F1: `<기능 1>`
  - F2: `<기능 2>`
- 주요 상태/모드(있다면):
  - `STATE_A`, `STATE_B` …

### 3.2 단위 내 함수 인덱스 (뷰어 추출용)
> Stage2 뷰어는 아래 테이블과 `<!-- PERFECTONE:FUNC ... -->` 마커를 사용해 함수 단위로 설계 내용을 보여줄 수 있다.

| Func ID | Function | Kind(EI/II) | Signature | Source Location | Description | Calls | Called By |
|---|---|---|---|---|---|---|---|
| FUNC-1 | <fn1> | EI | `<ret> <fn1>(...)` | `<file>:<line>` | <요약> | <list> | <list> |
| FUNC-2 | <fn2> | II | `<ret> <fn2>(...)` | `<file>:<line>` | <요약> | <list> | <list> |

---

## 4. 세부 설계 (필수) — 파일 관점

### 4.1 설계 원칙 / 코딩 규칙
- 적용 규칙: `<MISRA / CERT-C / 내부 규칙>`
- 방어적 프로그래밍:
  - Null 체크 정책: `<예: 모든 포인터 인자>`
  - Overflow 정책: `<예: saturate / error>`
  - Enum/Range 체크: `<예: default case 처리>`
- 오류 보고(진단) 정책: `<return code / global diag / event>`

### 4.2 동시성/타이밍/재진입성 가정
| 항목 | 값 | 근거/비고 |
|---|---|---|
| Reentrancy | <Yes/No> |  |
| Concurrency | <ISR/Task/Thread> | 공유자원/락 필요 여부 |
| Timing constraint | <ms/us> | Rate/Latency 요구와 연결 |
| Blocking allowed | <Yes/No> |  |

### 4.3 오류 처리 / 안전 메커니즘(요약)
- Fail-silent / Fail-safe / Degraded 등 전략: `<선택>`
- 안전 메커니즘(예):
  - 입력 범위 검증 + 에러 리턴
  - 상태 머신 가드
  - watchdog / timeout 감시(의존성 포함)
- “검증 가능한 형태”로 연결:
  - 어떤 INTF에 어떤 ASSERT를 걸고, 어떤 TC로 검증하는지 6~9절에서 연결한다.

### 4.4 알고리즘/동작 개요(파일 수준)
<!-- PERFECTONE:BLOCK_BEGIN id="ALGO-UNIT-1" kind="AI_PROPOSED" status="PROPOSED" -->
**[AI_PROPOSED]**
- 핵심 알고리즘 단계(요약):
  1) `<Step 1>`
  2) `<Step 2>`
  3) `<Step 3>`
- 상태 전이(있다면): `<텍스트/표/링크>`

---
<!-- PERFECTONE:BLOCK_END id="ALGO-UNIT-1" -->

## 5. 데이터 / 자원 (필수)

### 5.1 전역/정적 데이터(이 파일이 소유하거나 접근하는 데이터)
| Data ID | Name | Storage | Type | Init | Owner | Access(R/W) | Range/Invariant | Safety impact | Notes |
|---|---|---|---|---|---|---|---|---|---|
| DATA-1 | <g_x> | global | <type> | <init> | <module> | R/W | <규칙> | <ASIL?> |  |
| DATA-2 | <s_state> | static | <type> | <init> | this unit | R/W | <규칙> |  |  |

### 5.2 메모리/스택/리소스 사용
| Resource | Assumption | Upper bound | Monitoring | Notes |
|---|---|---|---|---|
| Stack | <bytes> | <n> | <how> |  |
| Heap | <allowed?> | <n> | <how> |  |
| IO/Handles | <count> | <n> | <how> |  |

---

## 6. 안전/품질 요구 매핑 (필수)

> **의도:** 요구사항(안전/품질/기능)을 단위 설계와 단위 테스트로 연결한다. (양방향 추적성의 핵심)

### 6.1 요구사항 매핑 표 (필수)
| REQ_ID | Requirement (요약) | Source (SG/TSR/SR/HLR) | ASIL | Design Rationale / Mitigation | Related INTF_ID | Related ASSERT_ID | Related TC_ID | Coverage Target | Notes |
|---|---|---|---|---|---|---|---|---|---|
| REQ-1 | <요구 요약> | <REF/ID> | **[USER_INPUT_REQUIRED]** <QM/A/B/C/D> | **[USER_REVIEW_REQUIRED]** <근거/미티게이션> | INTF-1 | ASSERT-1 | TC-1 | <Stmt/Br/MC/DC> |  |
| REQ-2 |  |  |  |  |  |  |  |  |  |

### 6.2 설계 결정(Design Decisions) & 근거
| DD_ID | Decision | Alternatives | Rationale | Impacted REQ/INTF | Verification (TC/Review) |
|---|---|---|---|---|---|
| DD-1 | <결정> | <대안> | <근거> | REQ-1, INTF-2 | TC-3 / Review |

---

## 7. 테스트 설계 & 결정 테이블 (필수)

### 7.1 테스트 전략(단위 관점)
- 테스트 유형:
  - 기능 테스트(정상/경계/에러)
  - 강건성(robustness) / 결함 주입(가능 시)
  - (선택) 성능/타이밍 단위 시험
- 커버리지 목표:
  - Statement / Branch / MC/DC: `<목표>`
  - 근거: `<ASIL/프로젝트 정책>`

### 7.2 테스트 케이스 CSV 연결(파일)
- CSV 파일: `.perfectone/docs/<unit>_tests.csv`
- 이 문서의 `TC_ID`는 CSV의 `TC_ID`와 **동일**해야 한다.

### 7.3 결정 테이블 템플릿 (함수/기능별로 1개 이상 권장)
> 복잡한 분기(특히 안전 관련)는 결정 테이블로 조건/행위를 명확히 정의한다.

#### DT-1: <대상 기능/함수>
| Rule ID | Condition C1: <조건> | Condition C2: <조건> | Condition C3: <조건> | Action A1: <행위> | Action A2: <행위> | Related REQ_ID | Related TC_ID |
|---|---|---|---|---|---|---|---|
| R1 | T | F | - | X | - | REQ-1 | TC-1 |
| R2 | F | T | - | - | X | REQ-2 | TC-2 |
| R3 | - | - | - | - | - |  |  |

### 7.4 경계값/동치분할 템플릿(입력 인터페이스별)
| INTF_ID | Parameter/Signal | Equivalence Classes | Boundaries | Invalids | Related TC_ID |
|---|---|---|---|---|---|
| INTF-1 | <x> | <정상군> | <min/max> | <out of range> | TC-1, TC-2 |

---

## 8. Assertion 계획 (필수)

> Assertion은 “설계의 계약(Contract)”이며, 단위 시험의 Oracle로 사용될 수 있다.

### 8.1 Assertion 목록(필수)
| ASSERT_ID | Location (file:line / function) | Type (Pre/Post/Invariant/Range/Error) | Condition (자연어 + 식) | Related INTF_ID | Related REQ_ID | Related TC_ID | Insertion Plan (manual/auto) | Notes |
|---|---|---|---|---|---|---|---|---|
| ASSERT-1 | <file:line> / <fn> | Pre | <조건> | INTF-1 | REQ-1 | TC-1 | auto |  |
| ASSERT-2 |  | Invariant |  |  |  |  |  |  |

### 8.2 Assertion 구현 가이드(템플릿)
- C 매크로 예시(프로젝트 정책에 맞춰 수정):
  - `PO_ASSERT(cond, ASSERT_ID)` / `PO_REQUIRE` / `PO_ENSURE`
- 실패 처리:
  - `<return code / diagnostic / abort 금지?>`
- 삽입 위치 원칙:
  - Precondition: 함수 시작부
  - Postcondition: 정상 리턴 직전
  - Invariant: 루프/상태 전이 직후 등

---

## 9. 추적성 (필수)

> **목표:** REQ ↔ INTF ↔ ASSERT ↔ TC ↔ Coverage 를 “항상” 연결 가능하게 한다.  
> Trace 정본은 `.perfectone/docs/trace.json`을 권장하며, unit export는 `<unit>_trace.json`을 사용한다.

### 9.1 Traceability Matrix (요약)
| REQ_ID | INTF_ID | ASSERT_ID | TC_ID | Coverage Evidence | Notes |
|---|---|---|---|---|---|
| REQ-1 | INTF-1 | ASSERT-1 | TC-1 | <coverage link / percent> |  |
| REQ-2 |  |  |  |  |  |

### 9.2 Coverage Evidence 링크(선택)
| Evidence ID | Type | Location | Scope | Notes |
|---|---|---|---|---|
| COV-1 | lcov html | `.perfectone/coverage/.../index.html` | unit |  |
| COV-2 | report | `.perfectone/...` | function |  |

---

## 10. 함수별 단위 설계 (필수) — Function Blocks

> 각 함수 섹션은 **아래 마커로 시작**한다. Stage2 뷰어가 함수 블록을 추출할 때 사용한다.

<!-- ===================================================================== -->
<!-- TEMPLATE: Duplicate the following block for each function in this file -->
<!-- ===================================================================== -->

<!-- PERFECTONE:FUNC name="<function_name>" kind="EI|II" signature="<ret fn(args)>" line="<line_number>" -->
### [FUNC] <function_name> (line <line_number>)

#### 10.<n>.1 목적 / 책임(Responsibility)
- 목적: `<이 함수가 무엇을 보장하는가>`
- 호출 타이밍/조건: `<언제 호출되는가>`
- 안전 관련 여부: `<Yes/No + 이유>`

#### 10.<n>.2 인터페이스 상세(필수)
> 함수 인자/리턴/전역변수/외부호출을 “인터페이스 관점”에서 정리한다. 아래 표의 각 Row는 2절의 `INTF_ID`와 연결되어야 한다.

| INTF_ID | Interface kind (Arg/Return/Global/Dep) | Name | Natural Name | Type | Unit | Range/Validity | Direction | Source | Target | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| INTF-1 | Arg | <arg1> | <의미> | <type> |  |  | In | caller | this fn |  |
| INTF-3 | Global | <g_x> | <의미> | <type> |  |  | InOut | this fn | module |  |
| INTF-2 | Dep | <dep_fn()> | <의미> | <sig> |  |  | Out | this fn | dep |  |

#### 10.<n>.3 전제조건(Preconditions) / 입력 검증
- Preconditions (자연어):
  - P1: `<조건>` (관련: INTF-?, ASSERT-?)
- 입력 검증 규칙:
  - Null/Range/Enum 검증: `<정책>`
  - 오류 시 처리: `<return/diag/state>`

#### 10.<n>.4 출력/사후조건(Postconditions)
- Postconditions (자연어):
  - Q1: `<정상 리턴 시 보장>` (관련: ASSERT-?)
- 출력 포맷/단위/해상도: `<필요 시>`

#### 10.<n>.5 오류 처리 / 예외 상황
| Error ID | Condition | Detection | Reaction | Return/Diag | Safety impact | Related TC |
|---|---|---|---|---|---|---|
| ERR-1 | <조건> | <방법> | <조치> | <값> | <ASIL?> | TC-? |

#### 10.<n>.6 알고리즘 상세(필수)
- 단계별 설명(권장: 번호 + 의사코드)
  1) `<Step>`
  2) `<Step>`
- 의사코드(선택):
```text
if (<cond>) then
  ...
else
  ...
end
```

#### 10.<n>.7 상태/데이터 흐름(선택, 권장)
- 읽는 데이터: `<DATA-ID/INTF-ID>`
- 쓰는 데이터: `<DATA-ID/INTF-ID>`
- 상태 전이(있다면): `<STATE_A -> STATE_B 조건>`

#### 10.<n>.8 Assertion 연결(필수)
| ASSERT_ID | Type | Condition | Location Plan | Related TC_ID | Notes |
|---|---|---|---|---|---|
| ASSERT-1 | Pre | <cond> | fn entry | TC-1 |  |
| ASSERT-2 | Post | <cond> | before return | TC-2 |  |

#### 10.<n>.9 테스트 설계 연결(필수)
- 관련 결정테이블: `DT-?`
- 관련 TC:
  - `TC-?`: `<요약>`
- 커버리지 포인트(Branch/MC/DC):
  - `<분기/조건 목록>`

#### 10.<n>.10 추적성(필수)
| REQ_ID | INTF_ID | ASSERT_ID | TC_ID | Notes |
|---|---|---|---|---|
| REQ-1 | INTF-1 | ASSERT-1 | TC-1 |  |

<!-- PERFECTONE:FUNC_END name="<function_name>" -->
<!-- ===================================================================== -->

---

## 11. 부록 (선택)

### 11.1 오픈 이슈 / TBD
| Issue ID | Description | Owner | Due | Status |
|---|---|---|---|---|
| ISS-1 | <TBD> | <name> | <date> | Open |

### 11.2 리뷰 체크리스트(권장)
- [ ] 모든 REQ가 최소 1개 TC/ASSERT로 연결됨(9절)  
- [ ] 모든 인터페이스(IN/OUT/Global/Dep)가 2절/10절에 정의됨  
- [ ] 결정테이블이 주요 분기 로직을 커버함(7절)  
- [ ] 오류 처리(에러코드/진단)가 테스트 가능하게 정의됨  
- [ ] 안전/품질 주장(ASIL 등)이 근거(REF/분석)와 연결됨  

### 11.3 CSV/Trace 최소 필드 매핑 (필수, Stage1 기준)

> 목적: Stage 1에서 생성되는 **CSV 스키마**와 **trace.json 스키마**가 1:1로 매칭될 수 있도록 “최소 필드”를 고정한다.  
> 원칙: 상세 설명/근거는 MD/CSV에 남기고, trace.json은 **ID와 링크(엣지)** 중심으로 유지한다.

#### (A) CSV 최소 컬럼(필수)
| Column | 설명 | 예 | 비고 |
|---|---|---|---|
| TC_ID | 테스트 케이스 ID | TC-1 | 파일 단위 고유 |
| Unit | unit slug | Source__foo | `.perfectone/docs/<unit>.md`와 일치 |
| Func | 대상 함수(또는 FUNC_ID) | foo_step | 복수면 `;` 구분 |
| REQ_IDs | 연관 요구 ID 목록 | REQ-1;REQ-3 | 복수 허용 |
| INTF_IDs | 연관 인터페이스 ID 목록 | INTF-1;INTF-2 | 복수 허용 |
| ASSERT_IDs | 연관 Assertion ID 목록 | ASSERT-1 | 복수 허용 |
| Type | 테스트 타입 | Normal/Boundary/Error/Robustness | 고정 enum 권장 |
| Preconditions | 사전조건 | s_state=INIT | 간단 텍스트 |
| Inputs | 입력값 요약(사람/LLM) | x=0, y=5 | 구조화는 Stage2+ |
| Expected | 기대 결과 요약 | ret=OK, g_out updated |  |
| CoverageTarget | 커버리지 목표 | Branch | 프로젝트 정책 연결 |
| Status | 상태 | DRAFT/REVIEWED/BASELINED | 문서와 정합 |

#### (B) trace.json 최소 필드(필수)
trace.json은 **ID ↔ 링크** 중심의 최소 그래프를 저장한다.

- 공통 필드(모든 artifact):
  - `id`: "REQ-1" / "INTF-2" / "ASSERT-1" / "TC-1"
  - `type`: "REQ" | "INTF" | "ASSERT" | "TC" | "FUNC"
  - `unit`: `<unit_slug>`
  - `links`: 관련 ID 배열(양방향을 권장)
  - `src`: `{ "file": "<path>", "line": <n> }`  (가능한 경우)

- TC artifact의 권장 links:
  - `links`: `[REQ-*, INTF-*, ASSERT-*, FUNC-*]`

- REQ/INTF/ASSERT artifact의 권장 links:
  - 최소 1개 `TC-*` 또는 상호 참조(예: REQ ↔ ASSERT)

> Stage1에서는 `src.line`은 best-effort(알 수 없으면 생략 또는 0). Stage2에서 저장 훅 검증 시 보완한다.

#### (C) MD ↔ CSV ↔ Trace 연결 규칙(요약)
- MD 6.1(REQ 매핑)에서 등장한 `REQ_ID`는 trace.json에 `type=REQ`로 존재해야 한다.
- MD 2.4(인터페이스 표)의 `INTF_ID`는 trace.json에 `type=INTF`로 존재해야 한다.
- MD 8.1(Assertion 목록)의 `ASSERT_ID`는 trace.json에 `type=ASSERT`로 존재해야 한다.
- CSV의 각 `TC_ID`는 trace.json에 `type=TC`로 존재해야 한다.
- Stage1 생성 시 **ID 선할당**(LLM은 설명만 채움) 원칙을 유지한다.


<!-- PERFECTONE:END -->
