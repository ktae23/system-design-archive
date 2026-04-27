# MySQL Online DDL과 메타데이터 락(MDL) — ALTER TABLE이 운영을 죽이는 이유

> 작성: cs-theory-tutor (backend-mentor)
> 연결 챌린지: `~/Desktop/backend-mentor/system-design/challenges/2026-04-05-traffic-surge.md`
> 한 줄 요약: **"트래픽 폭증 중에 ALTER TABLE을 실행하면 그것은 데이터베이스에 대한 자살행위다."**

---

## 1. 왜 이 주제인가

사용자가 Q3 답변에서 이렇게 말했다:

> "유니크 키 거는 동안 메타데이터 락 걸려서 커넥션이 드랍됐다."

이 문장은 부분적으로 맞고 부분적으로 틀리다. 정확히 무슨 일이 일어났는지 알아야
**다음에 똑같은 짓을 안 한다.** 시니어 백엔드 개발자가 이걸 모르면, 운영 DB를 죽일 수 있다.

핵심 키워드:
- **MDL (Metadata Lock)**: 테이블 정의를 보호하는 락
- **Online DDL**: MySQL 5.6+의 "운영 중 ALTER" 기능
- **OSC (Online Schema Change)**: pt-osc, gh-ost 같은 무중단 도구

---

## 2. MDL(Metadata Lock)의 정체

### 2.1 락의 두 종류

MySQL InnoDB에는 **두 층의 락**이 있다:

```
[ 데이터 락 (Row Lock, Gap Lock) ]   ← InnoDB 레벨, 행/범위 보호
        ↑
[ 메타데이터 락 (MDL) ]              ← Server 레벨, 테이블 정의 보호
        ↑
   SQL 쿼리
```

대부분의 개발자는 row lock만 안다. 그러나 **MDL이야말로 운영 DB를 죽이는 진짜 범인**이다.

### 2.2 MDL의 종류

| 락 종류 | 누가 잡는가 | 호환성 |
|---|---|---|
| **MDL_SHARED_READ** | SELECT | 다른 SHARED와 호환 |
| **MDL_SHARED_WRITE** | INSERT, UPDATE, DELETE | 다른 SHARED와 호환 |
| **MDL_EXCLUSIVE** | ALTER, DROP, RENAME, TRUNCATE | **아무것도 호환 안 됨** |

DML (SELECT/INSERT/UPDATE/DELETE)은 모두 **MDL_SHARED 계열**을 잡는다. 서로 호환되니 동시 실행 OK.

DDL (ALTER 등)은 **MDL_EXCLUSIVE**를 요구한다. 이걸 얻으려면 **현재 그 테이블에 걸린 모든 MDL_SHARED가 풀려야 한다.**

### 2.3 트랜잭션 종료 시점이 핵심

여기가 함정이다. **MDL은 쿼리가 끝났을 때가 아니라 트랜잭션이 커밋/롤백될 때 풀린다.**

```sql
-- 세션 A
BEGIN;
SELECT * FROM orders WHERE id = 1;   -- MDL_SHARED_READ 획득
-- 여기서 애플리케이션 로직 처리... (10초)
-- 아직 COMMIT 안 함!  ← MDL은 계속 잡혀있음
```

```sql
-- 세션 B (DBA)
ALTER TABLE orders ADD UNIQUE KEY uk_user_order (user_id, order_no);
-- → MDL_EXCLUSIVE 대기
-- → 세션 A가 COMMIT할 때까지 영원히 대기
```

```sql
-- 세션 C (서비스의 새 요청)
SELECT * FROM orders WHERE id = 2;
-- → 세션 B가 MDL_EXCLUSIVE 대기 중이므로
-- → 세션 C도 MDL_SHARED 대기 (FIFO 큐)
-- → 사용자: "어, 왜 안 들어가지?"
```

이게 **MDL 큐잉 문제**다. ALTER가 막히면, 그 뒤에 들어오는 모든 신규 쿼리도 같이 막힌다.

확인 방법:
```sql
SHOW PROCESSLIST;
-- State: "Waiting for table metadata lock"
SELECT * FROM performance_schema.metadata_locks;
```

---

## 3. 부하 상태에서 ALTER가 자살인 이유 (Cascading Failure)

다음은 사용자가 챌린지에서 겪을 시나리오의 정확한 분석이다.

### 시간순 시나리오

```
T+0초    : 트래픽 100배 폭증. 일부 트랜잭션이 평소보다 길어짐 (5~30초).
T+0초    : 누군가 "중복 주문 막자!" 하며 ALTER TABLE orders ADD UNIQUE KEY ...; 실행.
T+0.1초  : ALTER가 MDL_EXCLUSIVE 요청. 그러나 진행 중인 트랜잭션 50개가 MDL_SHARED 보유.
T+0.1초  : ALTER는 대기 큐에 들어감.
T+0.2초  : 새 INSERT 요청 도착 → MDL_SHARED 요청 → ALTER 뒤에 줄 섬 (대기).
T+0.5초  : 새 SELECT, INSERT가 모두 MDL 대기. 응답 없음.
T+1초    : 커넥션 풀이 가득 참 (HikariCP에서 connectionTimeout=30s가 일반적이지만,
            그 전에 풀 슬롯 모두 점유됨).
T+1.5초  : 신규 요청은 풀 획득 대기 → 애플리케이션 스레드도 블로킹.
T+2초    : 톰캣/노드 워커 다 잠김 → 헬스체크 실패 → 로드밸런서가 인스턴스를 unhealthy 처리.
T+5초    : 트래픽이 살아있는 인스턴스로 몰림 → 그 인스턴스도 같은 운명.
T+10초   : 서비스 완전 다운.
```

이게 **"ALTER 한 줄이 전사를 죽이는 메커니즘"**이다.

### 왜 부하 상태에서 더 위험한가

- **장시간 트랜잭션이 더 많다**: 100배 부하 → 쿼리 latency 증가 → 트랜잭션 길이 증가
- **MDL 큐가 더 빨리 길어진다**: 신규 요청 RPS가 평소의 100배
- **타임아웃 임계점이 빨리 옴**: 초당 10,000 요청 × 30초 대기 = 300,000개 블로킹 스레드 (불가능)

---

## 4. MySQL Online DDL의 한계

MySQL 5.6부터 "Online DDL" 기능을 도입했다. **하지만 "Online"이 "락 없음"을 의미하지 않는다.**

### 4.1 옵션 문법

```sql
ALTER TABLE orders
  ADD UNIQUE KEY uk_user_order (user_id, order_no),
  ALGORITHM=INPLACE,
  LOCK=NONE;
```

| 옵션 | 의미 |
|---|---|
| `ALGORITHM=COPY` | 새 테이블 만들고 데이터 복사 (구식, MySQL 5.5 방식) |
| `ALGORITHM=INPLACE` | 원본 테이블에서 변경 (대부분 가능) |
| `ALGORITHM=INSTANT` | 메타데이터만 변경 (MySQL 8.0+, 컬럼 추가만) |
| `LOCK=NONE` | DML 동시 실행 허용 |
| `LOCK=SHARED` | SELECT는 OK, 쓰기 차단 |
| `LOCK=EXCLUSIVE` | 모두 차단 |

### 4.2 그러나 함정

**`LOCK=NONE`이라도 시작과 끝 순간에는 짧은 MDL_EXCLUSIVE가 필요하다.**

```
[시작] ─ MDL_EXCLUSIVE 짧게 획득 (메타데이터 변경 시작)
       ─ 본 작업 (이 동안은 DML 가능)
[끝]  ─ MDL_EXCLUSIVE 짧게 다시 획득 (메타데이터 commit)
```

평소엔 그 "짧은" 순간이 밀리초라서 모르고 지나간다. 그러나 **부하 상태에서는 그 짧은 순간이 영원이 된다.**
장시간 트랜잭션 1개만 있어도 그 순간을 못 얻는다.

### 4.3 어떤 ALTER가 INPLACE/INSTANT 가능한가

MySQL 8.0 기준 (대략):

| 작업 | INSTANT | INPLACE | 데이터 재구성 |
|---|---|---|---|
| 컬럼 추가 (맨 뒤, 8.0.12+) | O | - | X |
| 컬럼 삭제 | X | O (8.0.29+ 일부) | O |
| **유니크 인덱스 추가** | X | O | **O (전체 스캔)** |
| 일반 인덱스 추가 | X | O | O |
| PK 변경 | X | X (COPY) | O (전체 재구성) |
| 컬럼 타입 변경 | 보통 X | 일부 | O |

**유니크 인덱스 추가는 INPLACE이지만 데이터 전체 검사가 필요**하다.
- 1억 행 테이블에 유니크 키 → 수십 분 ~ 수 시간 소요
- 그 동안 Replica 지연 발생 가능
- 시작/끝의 MDL_EXCLUSIVE가 부하 상태에서 못 얻을 위험

---

## 5. 실무 해법: pt-osc, gh-ost

부하 상태에서 안전하게 스키마 변경을 하려면 **OSC (Online Schema Change)** 도구를 쓴다.
원리는 동일하다: **그림자 테이블에 복사하면서, 원본 변경을 따라잡고, 마지막에 swap.**

### 5.1 pt-online-schema-change (Percona Toolkit)

```bash
pt-online-schema-change \
  --alter "ADD UNIQUE KEY uk_user_order (user_id, order_no)" \
  --execute \
  D=mydb,t=orders \
  --max-load Threads_running=50 \
  --critical-load Threads_running=200
```

동작:
1. `_orders_new`라는 그림자 테이블 생성 (원본과 동일 + ALTER 적용)
2. 원본 `orders`에 **트리거 3개** (INSERT/UPDATE/DELETE) 추가
   → 원본 변경분이 실시간으로 그림자 테이블에 복제됨
3. 원본 → 그림자로 chunk 단위 복사 (1000행씩 등)
4. 부하 모니터링 (`Threads_running`이 임계 초과 시 자동 정지/재개)
5. 복사 완료 시 RENAME으로 atomic swap
6. 트리거 제거

**장점**: 검증된 도구, 다양한 모니터링 옵션
**단점**:
- **트리거가 원본 테이블 쓰기에 오버헤드 추가** (모든 INSERT/UPDATE/DELETE가 2배 작업)
- 외래키가 있으면 복잡 (`--alter-foreign-keys-method`)
- 아주 큰 테이블에서 트리거 부하가 심함

### 5.2 gh-ost (GitHub Online Schema Transmogrifier)

```bash
gh-ost \
  --user="..." --password="..." \
  --host=replica.db \
  --database=mydb \
  --table=orders \
  --alter="ADD UNIQUE KEY uk_user_order (user_id, order_no)" \
  --execute
```

동작:
1. 그림자 테이블 생성 (동일)
2. **트리거 대신 binlog를 읽어서** 원본 변경분을 그림자에 적용
3. 보통 **Replica에서 작업** (마스터 부하 회피)
4. chunk 단위 복사 + binlog tail-following
5. cut-over 시 atomic swap

**장점**:
- **트리거 없음** → 원본 테이블 부하 없음
- 마스터에 영향 최소화 (replica에서 작업)
- 인터랙티브 컨트롤 (일시정지, 속도 조절, 임계점 조정)

**단점**:
- binlog 포맷이 ROW여야 함
- statement-based replication에서 동작 안 함
- 외래키 미지원 (정책상)

### 5.3 선택 기준

| 상황 | 추천 도구 |
|---|---|
| 외래키 있음 | pt-osc |
| 외래키 없음 + 부하 민감 | gh-ost |
| 마스터에 직접 작업 강제 | pt-osc |
| Replica 활용 가능 | gh-ost |
| AWS Aurora | gh-ost (Aurora binlog 지원) |
| 단순 작업 + 작은 테이블 + 한가한 시간 | 그냥 ALTER (INPLACE, LOCK=NONE) |

### 5.4 클라우드 매니지드 옵션

- **AWS Aurora**: `Fast DDL` (일부 작업 instant)
- **PlanetScale**: `Vitess` 기반, 자동 OSC + Deploy Request 워크플로우 (스키마 변경의 GitHub PR 같은 경험)
- **TiDB**: 분산 DB 자체 lockless schema change

---

## 6. 이번 챌린지 적용

### 6.1 절대 금지

> **트래픽 폭증 중에 `ALTER TABLE orders ADD UNIQUE KEY ...`를 실행하지 마라.**

100배 트래픽 + ALTER = 100% 다운. 위에서 본 cascading failure 시나리오가 그대로 재현된다.

### 6.2 단계별 권장 순서

1. **즉시 (트래픽 폭증 중)**:
   - 애플리케이션 레벨에서 중복 방어
     - Redis `SET NX EX` (idempotency key)
     - Sliding Window Rate Limit (user_id 기준)
   - DB는 건드리지 않는다.

2. **트래픽 진정 후 (예: 새벽)**:
   - `gh-ost` 또는 `pt-osc`로 유니크 인덱스 추가
   - 백필 완료 시점에 모니터링 강화

3. **장기**:
   - 스키마 변경 정책 수립 (peak 시간 ALTER 금지)
   - 모든 DDL은 OSC 도구 통해서만
   - 스테이징 환경에서 lock wait 시뮬레이션

### 6.3 만약 이미 데이터에 중복이 있다면

```sql
ALTER TABLE orders ADD UNIQUE KEY ...;
-- ERROR 1062 (23000): Duplicate entry '...' for key 'uk_user_order'
```

선행 작업:
```sql
-- 중복 찾기
SELECT user_id, order_no, COUNT(*)
FROM orders
GROUP BY user_id, order_no
HAVING COUNT(*) > 1;

-- 중복 정리 (예: 가장 최근 것만 남기고 삭제)
DELETE o1 FROM orders o1
INNER JOIN orders o2
WHERE o1.user_id = o2.user_id
  AND o1.order_no = o2.order_no
  AND o1.id < o2.id;

-- 그 다음 OSC 도구로 유니크 인덱스 추가
```

---

## 7. 면접 빈출 포인트

### Q1. "ALTER TABLE을 부하 상태에서 안전하게 거는 법은?"
A. 다음 순서로 답한다:
1. 먼저 그 ALTER가 INSTANT/INPLACE인지 확인. INSTANT면 메타데이터만 바꾸므로 안전 (단 컬럼 추가 등 제한).
2. INPLACE라도 시작/끝의 짧은 MDL_EXCLUSIVE 때문에 부하 상태에서 위험.
3. **부하 상태라면 OSC 도구 (gh-ost, pt-osc) 사용**. 그림자 테이블에 복사 후 atomic swap.
4. 사전 준비: long-running transaction 모니터링, MDL 대기 모니터링, 카나리 환경 검증.
5. 베스트는 **트래픽 적은 시간**에 하는 것 + OSC 도구.

### Q2. "MDL이 뭔가요? row lock과 차이는?"
A. MDL(Metadata Lock)은 **테이블 정의(schema)를 보호하는 락**이다. row lock은 InnoDB 레벨의 데이터 보호. DML은 MDL_SHARED, DDL은 MDL_EXCLUSIVE를 잡는다. **MDL은 트랜잭션 종료 시점까지 유지**되므로 long-running transaction이 ALTER를 무한 대기시킬 수 있다.

### Q3. "Online DDL이 진짜 online인가요?"
A. 아니다. `LOCK=NONE`이라도 시작/끝 순간에 짧은 MDL_EXCLUSIVE가 필요. 부하 상태에서는 그 순간조차 못 얻을 수 있다. 진짜 무중단을 원하면 OSC 도구 필요.

### Q4. "gh-ost와 pt-osc 차이는?"
A. 둘 다 그림자 테이블 + atomic swap 패턴. **차이는 동기화 메커니즘**:
- pt-osc: **트리거** (원본 쓰기마다 그림자에도 적용) → 원본 부하 증가
- gh-ost: **binlog 읽기** (replica에서 작업 가능) → 원본 부하 없음
gh-ost가 더 권장되지만, 외래키 있으면 pt-osc 선택.

### Q5. "MDL 대기 어떻게 모니터링하나요?"
A.
```sql
SELECT * FROM performance_schema.metadata_locks
WHERE LOCK_STATUS = 'PENDING';

SELECT * FROM information_schema.processlist
WHERE State LIKE '%metadata lock%';
```
또한 `innodb_lock_wait_timeout`과 별개로 `lock_wait_timeout` (MDL 전용, 기본 1년) 설정 권장. ALTER 실행 시 `SET lock_wait_timeout = 5;`로 짧게 설정해서, 못 얻으면 빨리 실패하게.

---

## 8. 이걸 모르면 어떻게 털리는가

**시니어 면접 실패 시나리오**:

> 면접관: "운영 중인 1억 행 테이블에 유니크 키 어떻게 추가하시겠어요?"
> 후보자: "ALTER TABLE에 ALGORITHM=INPLACE, LOCK=NONE 붙이면 됩니다."
> 면접관: "그게 진짜 lock-free인가요? 시작과 끝에 무슨 일이 일어나죠?"
> 후보자: "..."
> 면접관: "장시간 트랜잭션이 하나 있으면 ALTER가 어떻게 되죠?"
> 후보자: "...timeout 나지 않을까요?"
> 면접관: "ALTER가 대기하는 동안 새로 들어오는 SELECT는요?"
> 후보자: "그것도 됩니다."
> 면접관: "그럼 서비스가 다운되겠죠. 이걸 막는 방법은?"
> 후보자: "..."

**합격 답변**:

> "MySQL Online DDL의 INPLACE는 본 작업 중엔 DML 가능하지만, **시작/끝 순간엔 MDL_EXCLUSIVE를 짧게 잡습니다.** 부하 상태에선 그 순간을 못 얻을 위험이 있고, 그 사이 신규 쿼리가 모두 MDL 대기 큐에 쌓여 cascading failure로 이어집니다. 안전한 방법은:
> (1) `lock_wait_timeout`을 5초 정도로 짧게 설정해서 빨리 실패하게 하고,
> (2) `gh-ost`로 그림자 테이블 + binlog 동기화 + atomic swap 방식 사용.
> 외래키가 있다면 pt-osc, 없다면 gh-ost 선호. 작업 전엔 long-running transaction 모니터링 필수입니다."

---

## 9. 추가 학습 포인트

- **`lock_wait_timeout`** vs `innodb_lock_wait_timeout`: 전자는 MDL, 후자는 row lock. 다르다.
- **MySQL 8.0 INSTANT ADD COLUMN**: 메타데이터만 변경. 단 한정적 (맨 뒤 컬럼 추가 등).
- **DDL과 Replica Lag**: OSC 작업 중 binlog 폭증으로 replica lag 발생 가능. `--max-lag-millis` 옵션으로 제어.
- **Aurora Fast DDL**: Aurora MySQL은 일부 ALTER를 즉시 처리. 단 아직 제한적.
- **PostgreSQL의 경우**: `CREATE INDEX CONCURRENTLY`로 비교적 안전한 인덱스 생성 가능. 그러나 `ALTER TABLE ADD CONSTRAINT UNIQUE`는 여전히 ACCESS EXCLUSIVE 필요.

---

## 10. 챌린지 즉시 적용 체크리스트

- [ ] 트래픽 폭증 중 절대 ALTER 금지 (런북에 명시)
- [ ] DDL 실행 전 `lock_wait_timeout = 5` 설정
- [ ] long-running transaction 모니터링 알람 (예: 10초 초과 시 알람)
- [ ] OSC 도구 (gh-ost 권장) 도입 및 검증
- [ ] 스테이징에서 부하 + ALTER 동시 시뮬레이션
- [ ] 중복 주문 방지는 1차로 애플리케이션 레벨 (idempotency key + sliding window)
- [ ] 유니크 키는 트래픽 진정 후 OSC로 추가
- [ ] DDL 정책 문서화 (peak hour 금지, OSC 강제)
