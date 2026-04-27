# 학습 수준 진단 리포트 (Level Assessment)

> **대상**: 5년차 백엔드 개발자
> **진단자**: 20년차 시니어 백엔드 멘토 (curriculum-designer)
> **작성일**: 2026-04-23
> **방법론**: 자가진단 5문항 + 시니어 관점 갭 보정

---

## 들어가며: 왜 "갭 보정"이 필요한가

5년차 개발자가 **"중급"**이라고 답하면, 현장에서의 실제 수준은 대부분 **"중급 하위 ~ 중급 중위"**에 걸쳐 있다.
이건 실력이 모자라서가 아니라, 5년차쯤 되면 **"아는 것 같다고 착각하기 쉬운 구간"**을 지나고 있기 때문이다.

- 책이나 블로그에서 읽은 용어 (MVCC, TIME_WAIT, Fork) → **이름은 안다**
- 실제 장애 대응이나 시스템 설계에서 **그 개념을 근거로 판단을 내린 경험** → **적다**

그래서 이 리포트는 자가진단 답변을 그대로 받아들이지 않는다.
"중급이라고 답했다 = 중급이다"가 아니라, **"중급이라 답할 만큼 그 영역에 노출되었다"** 정도로 해석하고, 면접관/시니어 시점에서 **실제 경계선이 어디쯤 걸쳐 있는지**를 드러낸다.

---

## 1. 네트워킹 (Networking)

### 현재 수준
- **자가진단**: 중급
- **실제 수준 (시니어 관점 보정)**: **중급 하위** — "용어는 설명할 수 있으나, 장애 시나리오에서 스택을 거슬러 올라가는 힘은 아직 약함"

### 아는 것 / 모를 것 경계선

**✅ 알고 있을 것**
- TCP 3-way handshake 개념, `TIME_WAIT`/`CLOSE_WAIT` 용어 구분
- HTTP Keep-Alive의 목적 (연결 재사용)
- DNS 리솔빙 흐름 (resolver → root → TLD → authoritative)
- L4는 TCP 레벨, L7은 HTTP 레벨이라는 **레이어 구분**

**❌ 아직 모를 가능성이 높은 것**
- `TIME_WAIT`가 **왜** 2MSL인지, 왜 **연결을 먼저 끊은 쪽**에만 생기는지
- `CLOSE_WAIT`이 대량 발생할 때 — 이건 **네트워크 문제가 아니라 애플리케이션 버그** (close() 누락)라는 진단 능력
- Keep-Alive가 있어도 **유휴 커넥션이 LB/방화벽에서 먼저 끊기는 문제** (idle timeout 역전)
- DNS TTL이 **장애 전파 속도를 결정한다**는 실전 감각 (블루-그린 배포, 페일오버 타이밍)
- L4 LB가 **sticky session**을 하는 방법 vs L7 LB의 방법 차이와 **비용**
- TCP `SYN backlog`, `somaxconn`, `accept queue` 같은 커널 파라미터가 트래픽 급증 시 드러나는 순간

### 시니어 관점 코멘트 (면접관 시점)

> "`TIME_WAIT`, Keep-Alive 설명할 수 있어요" — 좋다. 근데 면접관이 바로 이어붙일 꼬리질문:
> **"그럼 로드밸런서 뒤에 서버 5대 있는데, 새벽 2시에 한 대만 CPU가 튀어요. netstat 찍어보니 `TIME_WAIT`이 3만 개. 뭐 때문일까요?"**
>
> 이 질문에서 원하는 답은 "TIME_WAIT은 2MSL 동안…" 같은 교과서 답이 아니다.
> **"해당 서버가 outbound 커넥션을 대량으로 만들고 있다 → 외부 API 콜? DB 커넥션? Keep-Alive 안 붙은 HTTP 클라이언트?"**
> 이런 **역추적**이 나와야 중급 중위 이상이다.
>
> 용어를 **아는 것**과 용어를 **단서로 쓰는 것**은 다르다. 지금은 전자에 머물러 있을 가능성이 크다.

### 다음 수준으로 가기 위한 핵심 개념

1. **TCP 상태 머신 전체 그림** — `TIME_WAIT`/`CLOSE_WAIT` 단편이 아니라 11개 상태 전이를 실제 `tcpdump` 위에서 읽기
2. **HTTP/1.1 vs HTTP/2 vs HTTP/3** — Head-of-Line Blocking이 각 레이어에서 어떻게 발생/해결되는지
3. **Connection Pooling 메커니즘** — HikariCP, gRPC 채널, HTTP 커넥션 풀의 공통 함정 (`connection leak`, `pool exhaustion`)
4. **TLS 핸드셰이크와 mTLS** — 왜 인증서 체인 검증이 느린지, Session Resumption이 왜 필요한지
5. **Anycast/BGP 수준의 CDN/DNS 아키텍처** — 면접에서 "글로벌 서비스 설계" 나왔을 때 레이어를 넘어 사고하기

---

## 2. 데이터베이스 (Database)

### 현재 수준
- **자가진단**: 중급
- **실제 수준 (시니어 관점 보정)**: **중급 중위** — "용어와 개념은 깊게 봤음. 다만 **동시성 시나리오를 섞어서 풀어내는 힘**에서 갈린다"

**이 영역이 5개 중 가장 단단해 보인다.** MVCC, Phantom Read, Next-Key Lock을 거론하는 5년차는 많지 않다. 문제는 **개념 낱개로는 말할 수 있지만, "이게 왜 이 상황에서 튀어나오는가"를 엮어서 설명**할 수 있는지다.

### 아는 것 / 모를 것 경계선

**✅ 알고 있을 것**
- 트랜잭션 ACID, Isolation Level 4단계
- MVCC가 "각 버전의 스냅샷을 유지"한다는 개념
- Phantom Read, Dirty Read, Non-repeatable Read 정의
- Next-Key Lock = Record Lock + Gap Lock
- `EXPLAIN` 결과에서 `type`, `rows`, `Extra` 읽기

**❌ 아직 흔들릴 가능성이 높은 것**
- **Lost Update vs Phantom Read 혼동** — 둘 다 "읽고 쓰는 타이밍 문제"처럼 보이지만 원인/해결이 다르다
- MVCC **undo segment** 누적이 왜 장애를 만드는지 (long-running transaction이 `UNDO` 공간을 먹는 사건)
- InnoDB Gap Lock이 **deadlock 만드는 전형 패턴** — 순서 다른 두 트랜잭션이 같은 gap을 잡으러 들어갈 때
- `SELECT ... FOR UPDATE`와 `SELECT ... LOCK IN SHARE MODE`의 **실무 선택 기준**
- `READ COMMITTED` vs `REPEATABLE READ` — **MySQL의 REPEATABLE READ는 왜 Phantom을 막는가** (SERIALIZABLE이 아닌데)
- Index Condition Pushdown, Covering Index, Index Dive — `EXPLAIN`은 봤지만 이 세 개념이 쿼리 플래너에서 차지하는 비중
- 복제 지연(replication lag)이 **읽기 쿼리 분산 구조를 어떻게 깨는지** (read-after-write consistency)

### 시니어 관점 코멘트 (면접관 시점)

> "MVCC 설명해주세요" → "각 트랜잭션이 스냅샷을 보기 때문에…" → **좋다.**
> 근데 면접관의 진짜 질문은 여기부터다:
>
> **"그럼 주문 테이블에서 `SELECT COUNT(*) WHERE status='PENDING'`을 계속 조회하는 배치가 있어요. 이게 30분 걸려요. 이때 누가 `UPDATE status='CONFIRMED' WHERE id=123`을 하면 어떻게 되죠?"**
>
> 여기서 시험되는 건:
> 1. "배치 트랜잭션의 스냅샷은 시작 시점 고정" → MVCC 이해
> 2. "업데이트는 블록되지 않지만 undo 로그가 쌓임" → 실무 감각
> 3. "배치가 길수록 undo가 비대해져서 다른 세션의 스냅샷 읽기가 느려짐" → 장애 전조 감지
>
> 여기까지 가면 **중급 상위**. "MVCC는 스냅샷이에요"까지만 가면 **중급 하위**.
> 당신은 **중간 어딘가**에 있다. 1~2번은 닿지만 3번은 아직 낯설 것.

### 다음 수준으로 가기 위한 핵심 개념

1. **Isolation Level별 Anomaly 매트릭스 직접 재현** — 터미널 두 개 열고 세션 두 개로 Dirty/Non-repeatable/Phantom/Lost Update를 한 번씩 **눈으로** 만들기
2. **Lock 모니터링 실전** — `SHOW ENGINE INNODB STATUS`, `performance_schema.data_locks`로 deadlock 원인 직접 파싱
3. **쿼리 플랜 읽기** — `EXPLAIN ANALYZE` (PG) / `EXPLAIN FORMAT=JSON` (MySQL)로 **hash join vs nested loop** 구분 감각
4. **샤딩/파티셔닝 설계 원칙** — Hot Partition 예방, Rebalancing 전략 (Consistent Hashing으로 연결)
5. **CAP vs PACELC** — 왜 단순 CAP으로는 복제 지연을 설명할 수 없는지

---

## 3. 운영체제 (Operating System)

### 현재 수준
- **자가진단**: 중급
- **실제 수준 (시니어 관점 보정)**: **중급 하위** — "용어 구분은 되지만, 그 차이가 **성능/장애로 언제 드러나는가**를 연결 짓는 힘은 약함"

### 아는 것 / 모를 것 경계선

**✅ 알고 있을 것**
- 동기/비동기 vs 블로킹/논블로킹 2x2 매트릭스 구분
- Fork는 새 프로세스, Thread는 주소 공간 공유
- CPU bound vs I/O bound 개념
- `top`/`ps`로 프로세스 상태 확인

**❌ 아직 모를 가능성이 높은 것**
- **Context Switch 비용**이 언제 임계점을 넘는지 (thread 수 vs 코어 수, C10K 문제)
- `epoll`/`kqueue`/`io_uring` 같은 **이벤트 루프 내부** — Node.js/Netty가 왜 싱글스레드로 수만 개 커넥션을 받는지
- **File Descriptor 한계**(`ulimit -n`)가 **장애의 가면**이 되어 나타나는 순간 ("Too many open files")
- **Memory Overcommit**과 OOM Killer — 컨테이너에서 JVM 프로세스가 알 수 없이 죽는 이유
- **Copy-on-Write (CoW)**가 Fork를 싸게 만드는 원리, 반대로 Redis가 RDB 저장 시 **메모리 2배 쓰는 것처럼 보이는 이유**
- `signal` 처리의 함정 (Java에서 `kill -15` vs `kill -9`, JVM의 shutdown hook 타이밍)
- **CPU Cache Line / False Sharing** — 멀티스레드 성능 최적화의 근본
- Linux의 **cgroup/namespace** = 컨테이너 격리의 실체

### 시니어 관점 코멘트 (면접관 시점)

> "동기 블로킹과 비동기 논블로킹의 차이 설명해주세요" → "동기는 호출이 끝날 때까지 기다리고…"
>
> **이건 5년차에게 요구되는 답이 아니다. 신입 답이다.**
>
> 5년차에게 면접관이 원하는 건 이거:
> **"우리 서비스 API 평균 응답 200ms인데 p99가 2초 튀어요. 스레드풀 200개로 잡았는데 왜 그럴까요?"**
>
> 여기서 갈린다:
> - "스레드가 부족해요"까지 가면 **초급**
> - "I/O 대기 스레드가 늘어나서 컨텍스트 스위치가 폭증하거나, GC pause 또는 외부 의존성 latency 튀었을 수 있어요"까지 가면 **중급**
> - "스레드풀이 blocking call을 받는 구조인데, 외부 API 하나가 느려지면 풀 전체가 drain됨. 이게 bulkhead 패턴이 필요한 이유"까지 가면 **시니어**
>
> 당신은 첫 번째 선 위에 있다. 용어는 아는데 **"언제 어느 OS 개념이 장애로 둔갑하는지"**에 대한 감각이 아직 얇다.

### 다음 수준으로 가기 위한 핵심 개념

1. **Thread Model별 비교 체감** — 1 thread / 1 connection (Apache) vs 이벤트 루프 (Nginx/Node) vs Goroutine (Go) 실제 코드로 비교
2. **Linux 진단 도구 7종 세트** — `top`, `vmstat`, `iostat`, `pidstat`, `strace`, `perf`, `ss` — 각각 언제 쓰는지
3. **JVM/런타임 메모리 모델** — Heap/Metaspace/Direct Buffer, GC 종류(G1, ZGC)와 p99 latency 관계
4. **Linux Networking Stack 기초** — 패킷이 NIC → 커널 → 소켓 버퍼 → 애플리케이션까지 오는 흐름
5. **시스템 콜과 성능의 관계** — `strace` 직접 돌려서 syscall 빈도 파악

---

## 4. 알고리즘 / 자료구조 (Algorithms & Data Structures)

### 현재 수준
- **자가진단**: 기초
- **실제 수준 (시니어 관점 보정)**: **기초 — 정확함** ("정직한 답변" 구간. 5년차가 "기초"라고 답한 건 오히려 신뢰 지표)

### 5년차 백엔드에게 알고리즘이란

솔직한 관점부터 말한다.

**5년차 백엔드 개발자에게 알고리즘은 "면접 통과용"이고, 실무의 핵심이 아니다.**
LeetCode Hard를 푸는 능력이 시니어리티와 상관관계가 그리 크지 않다. 대신 **"실무 자료구조 감각"**이 훨씬 중요하다.

"실무 자료구조 감각"이란:
- 캐시 설계할 때 **LRU vs LFU vs TTL만 쓰기**의 트레이드오프를 즉답할 수 있는가
- Rate Limiter를 구현하라고 할 때 **Token Bucket / Leaky Bucket / Sliding Window**의 자료구조 차이를 설명할 수 있는가
- 중복 제거해야 할 때 **Set**을 쓸지 **Bloom Filter**를 쓸지 판단할 수 있는가
- Top-N 문제에서 **Heap (Priority Queue)**을 떠올릴 수 있는가
- 이벤트 순서 보장에서 **Queue (FIFO)**와 **Sorted Set (ZSET)**을 언제 나눠 쓰는지

**이 감각이 알고리즘 중급이다.** LeetCode DP 문제를 못 풀어도 상관없다.

### 아는 것 / 모를 것 경계선

**✅ 알고 있을 것**
- Array, HashMap, List 기본 사용
- 시간복잡도 O(n), O(log n), O(n²) 이름

**❌ 아직 모를 가능성이 높은 것**
- **Amortized Analysis** — ArrayList의 `add`가 왜 평균 O(1)인지
- HashMap의 **해시 충돌**이 성능을 어떻게 깨는지 (Java 8 이후 Red-Black Tree 전환)
- **Heap**의 실무 용도 — Priority Queue, Top-K, Scheduler
- **LRU Cache** 내부 구조 (Doubly Linked List + HashMap의 합성)
- **Bloom Filter** — 왜 "있을 가능성"만 판단하는가, 왜 그게 실무에서 유용한가
- **Trie** — 자동완성, IP 라우팅 테이블, 접두사 검색
- **Consistent Hashing** — 왜 `hash(key) % N`이 샤딩에서 지옥을 만드는지
- **Skip List** — Redis ZSET의 내부

### 시니어 관점 코멘트 (면접관 시점)

> 알고리즘 영역은 **이력서의 약점이 아니라 "솔직함의 증거"**로 포지셔닝하는 게 맞다.
> "복잡한 DP 문제를 빨리 푸는 건 부족하지만, LRU 캐시나 Rate Limiter 구현은 직접 해봤습니다"가 훨씬 강하다.
>
> 면접관이 알고리즘으로 5년차에게 보려는 건:
> 1. **기본 자료구조를 실전에 매핑할 수 있는가** (Redis 쓸 때 어떤 자료형 선택?)
> 2. **시간복잡도를 설계 판단의 근거로 쓸 수 있는가** ("이 조회가 O(n)이면 n이 100만 넘어가면 못 버팁니다")
> 3. **트레이드오프 감각** (해시 vs 트리, 공간 vs 시간)
>
> 이 세 가지는 코딩 테스트 없이도 **시스템 디자인 인터뷰 중간중간에 드러낸다.**

### 다음 수준으로 가기 위한 핵심 개념

1. **실무 자료구조 7선** — HashMap 내부, Heap/PriorityQueue, LRU, Bloom Filter, Trie, Skip List, Consistent Hashing
2. **시간/공간 복잡도 "감" 훈련** — 각 자료구조 연산의 Big-O를 외우지 말고 "왜 그런가"로 이해
3. **Amortized / Worst Case / Average 구분** — 면접 꼬리질문의 단골
4. **Redis 자료형 전체 훑기** — String/List/Hash/Set/ZSet/Stream이 어떤 자료구조로 구현됐는지
5. **Top-K / Heavy Hitters 같은 "실무 패턴 문제" 5개** — 코딩테스트 대신 이걸 준비하기

---

## 5. 시스템 디자인 (System Design)

### 현재 수준
- **자가진단**: 중급
- **실제 수준 (시니어 관점 보정)**: **중급 하위** — "기술 선택 경험은 있으나, **트레이드오프를 명시적 언어로 풀어내는 근육**은 덜 자람"

### 아는 것 / 모를 것 경계선

**✅ 알고 있을 것**
- Redis 캐시의 목적과 전형적인 적용 (hot read 완화)
- Kafka vs RabbitMQ 대략적 비교 (pub/sub vs queue)
- 데이터베이스 Master-Slave 복제 개념

**❌ 아직 모를 가능성이 높은 것**
- **Cache Aside / Write Through / Write Behind / Refresh Ahead** 4개 패턴의 장단과 **실제 선택 기준**
- **Cache Stampede (Thundering Herd)** — 캐시 만료 순간 트래픽이 원본 DB로 몰리는 현상과 해결(singleflight, soft expiry, randomized TTL)
- Kafka의 **at-least-once / at-most-once / exactly-once**의 진짜 의미와 **idempotent consumer 필요성**
- Kafka **Consumer Group rebalance**가 장애로 이어지는 순간
- **CAP의 오해** — "Partition이 없을 때는 CAP이 의미 없다"는 사실
- **Idempotency Key**가 왜 필수인지, 어디서 어떻게 저장해야 하는지
- **Outbox Pattern / Saga Pattern / CDC** 같은 **분산 트랜잭션 대안**
- **Rate Limiter**의 각 구현 (Token Bucket, Sliding Window Log, Sliding Window Counter)의 메모리/정확도 트레이드오프
- **API Gateway vs Service Mesh**의 책임 분리

### 시니어 관점 코멘트 (면접관 시점)

> "Redis 캐시 도입 경험 있습니다"는 5년차에게 **최소 요건**이지 **장점**이 아니다.
> 시스템 디자인 인터뷰에서 면접관이 5년차에게 기대하는 건 **"결정을 언어화하는 힘"**이다.
>
> 예를 들어 "캐시 도입했어요" 다음에 바로 이어붙일 수 있어야 하는 문장:
> - **"Cache Aside로 갔고, Write Through는 검토하다 빠졌는데, 이유는 ○○입니다"**
> - **"TTL은 ○분으로 잡았고, 캐시 스탬피드는 randomized TTL + singleflight로 막았습니다"**
> - **"Invalidation은 ○○ 이벤트에서 발생하는데, 일관성 윈도우는 ○초까지 허용하기로 프로덕트와 협의했습니다"**
>
> 이 세 문장이 나오면 **중급 상위**.
> "Redis 써서 빨라졌어요"까지면 **중급 하위**.
>
> 당신은 **경험은 있으나, 경험을 구조화된 언어로 압축**하는 훈련이 부족한 상태다. **이게 역학습 커리큘럼으로 가장 잘 해결되는 영역**이기도 하다.

### 다음 수준으로 가기 위한 핵심 개념

1. **트레이드오프 언어 5종** — Consistency vs Availability, Latency vs Throughput, Cost vs Complexity, Coupling vs Duplication, Fail-Fast vs Fail-Safe
2. **분산 시스템 핵심 8개념** — Idempotency, Retry with Backoff, Circuit Breaker, Bulkhead, Timeout, Rate Limiting, Backpressure, Graceful Degradation
3. **메시지 전달 보장 시맨틱** — At-most-once / At-least-once / Exactly-once가 실제로 뭘 의미하는지
4. **데이터 일관성 모델 스펙트럼** — Strong / Linearizable / Sequential / Causal / Eventual의 실무 예시
5. **5가지 전형 시스템 디자인** — URL Shortener, Newsfeed, Rate Limiter, 분산 ID 생성기(Snowflake), 실시간 채팅 — 이걸 **화이트보드에서 혼자 끝까지** 그릴 수 있는 힘

---

## 종합 코멘트: 이 사람은 이런 타입의 5년차다

### 페르소나 진단: **"현장에서 배운 성실한 실무형 5년차, 지금 전환점에 서 있음"**

당신은 **책보다 코드로 먼저 배운 사람**이다. MVCC, Phantom Read, L4/L7 같은 용어가 나오는 걸 보면, 쏟아지는 장애/이슈를 **구글링과 동료 답변으로 메꾸며 자라온 궤적**이 보인다. 이건 깎아내리는 얘기가 아니라 **한국 5년차 백엔드의 가장 흔하고 건강한 경로**다. 실전 감각은 있고, 기본 용어도 빠지지 않고 따라왔다.

그래서 **지금이 전환점**이다. 5년차까지는 "급한 불 끄는 능력"과 "기능 빠르게 만드는 능력"으로 간다. 그런데 이걸 넘어서 **시니어로 가려면 두 가지가 붙어야 한다**:

1. **원리 수준에서 말할 수 있는 힘** — "왜 그렇게 동작하는지"를 **코드 밑 레이어(OS, 네트워크, DB 엔진)**에서 설명하는 것
2. **판단을 언어화하는 힘** — 설계 선택을 **트레이드오프의 언어**로 압축해서 말하는 것

이 두 가지는 둘 다 **"역학습(Reverse Learning)"에 잘 맞는다.**
- 원리 수준 이해 → 시스템 디자인 설계하다 막히는 지점에서 이론이 자연스럽게 필요해진다
- 판단 언어화 → 시스템 디자인 설계를 **말로 풀어내는 훈련**이 곧 트레이닝이다

데이터베이스 영역이 가장 단단하고(중급 중위), 네트워킹/OS/시스템디자인이 중급 하위에서 묶여 있다. 알고리즘은 솔직한 기초. 이 **"DB만 살짝 더 단단하고 나머진 비슷한 층에 있는"** 프로파일은 역학습에 최적이다. 왜냐하면 **DB가 시스템 디자인의 중심축이기 때문**에, DB 주변에서 네트워킹/OS/자료구조 개념이 전부 불려 나오도록 커리큘럼을 설계할 수 있다.

**결론**: 기본기는 갖춘 성실한 5년차. 단, **"안다"와 "설계 판단에 쓸 수 있다"의 사이**에 한 층이 더 필요한 상태. 12주 커리큘럼에서는 **이 한 층을 채우는 것**을 최우선 목표로 삼는다.
