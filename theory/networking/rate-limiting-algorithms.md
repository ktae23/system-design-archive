# Rate Limiting 알고리즘 — Token Bucket vs Leaky Bucket vs Sliding Window vs Fixed Window

> 작성: cs-theory-tutor (backend-mentor)
> 연결 챌린지: `~/Desktop/backend-mentor/system-design/challenges/2026-04-05-traffic-surge.md`
> 한 줄 요약: **"Rate Limit을 Redis로 한다"는 답은 시작도 못 한 답이다. 어떤 알고리즘이냐가 본질이다.**

---

## 1. 왜 이 알고리즘들이 필요한가 — 트래픽 100배 시나리오

평소 1,000 RPS를 처리하던 주문 API가 **타임 세일** 한 방에 100,000 RPS로 폭증한다.
이 때 Rate Limiter가 없으면:

- DB 커넥션 풀 고갈 → cascading failure
- 동일 사용자가 결제 버튼을 100번 연타 → **중복 주문**
- 봇이 재고를 싹쓸이

Rate Limiter는 **"누구를, 어느 단위로, 얼마만큼" 통과시킬지** 결정하는 게이트다.
그런데 "1분에 60회 허용"이라는 동일 정책도 **알고리즘이 무엇이냐에 따라 실제 동작이 완전히 달라진다.**

비유로 잡자:

| 알고리즘 | 비유 |
|---|---|
| **Token Bucket** | 음료수 자판기 옆에 동전 항아리. 평소엔 동전을 모아두고, 한꺼번에 5캔 뽑을 수 있음. 단 평균은 제한. |
| **Leaky Bucket** | 구멍 뚫린 양동이. 위에서 물(요청)이 아무리 빨리 들어와도 **아래로는 일정 속도로만** 빠짐. 넘치면 버림. |
| **Fixed Window** | 매 분 0초에 계수기 리셋. "이번 분 안에 60번까지 OK". 단순하지만 경계 burst 문제. |
| **Sliding Window** | "지금 이 순간으로부터 과거 60초 안에 몇 번 호출했지?" 진짜 시간 기준. 가장 정확. |

핵심 질문은 항상 두 가지다:
1. **Burst(순간 폭증)를 허용할 것인가?**
2. **얼마나 정확하게 카운트할 것인가? (메모리/CPU 비용은?)**

---

## 2. 4종 비교표

| 알고리즘 | Burst 허용? | 메모리 비용 | 정확도 | 구현 난이도 | 적합한 케이스 |
|---|---|---|---|---|---|
| **Token Bucket** | O (버킷 가득 차 있는 만큼) | 사용자당 2개 변수(tokens, last_refill) | 중상 | 쉬움 | API Gateway, 외부 API 클라이언트 측 throttle |
| **Leaky Bucket** | X (출구 속도 일정) | 사용자당 큐 또는 카운터 | 중 | 중간 | Nginx 프록시, 일정 처리율 보장 |
| **Fixed Window** | O (경계에서 2N까지 가능) | 사용자당 1 카운터 | 하 (경계 burst) | 매우 쉬움 | 로깅, 일일 쿼터처럼 정확도 덜 중요한 케이스 |
| **Sliding Window Log** | X (정확) | 요청마다 timestamp 저장 (O(N)) | 최상 | 중간 | 정확한 카운트가 필수, 트래픽 적은 곳 |
| **Sliding Window Counter** | 약간 (가중평균) | 사용자당 2 카운터 | 상 | 중간 | Cloudflare, Kong, 대규모 정확도+효율성 |

---

## 3. 각 알고리즘 상세 + 코드

### 3.1 Token Bucket

```text
[ 토큰이 초당 r개 추가됨, 최대 b개까지 ]
 요청 도착 → 토큰 1개 소모 → 통과
 토큰 0개 → 거절(또는 대기)
```

핵심 수식:
```
now = current_time()
elapsed = now - last_refill
tokens = min(burst, tokens + elapsed * refill_rate)
if tokens >= 1:
    tokens -= 1
    return ALLOW
else:
    return DENY
last_refill = now
```

Redis Lua 예시:
```lua
-- KEYS[1] = bucket key, ARGV: now, refill_rate, burst
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1]) or tonumber(ARGV[3])
local ts = tonumber(data[2]) or tonumber(ARGV[1])
local elapsed = tonumber(ARGV[1]) - ts
tokens = math.min(tonumber(ARGV[3]), tokens + elapsed * tonumber(ARGV[2]))
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', ARGV[1])
return allowed
```

**특징**: burst 허용이 본질. 평균은 제한하되 순간적인 폭증은 OK. AWS API Gateway, Stripe API의 표준 모델.

### 3.2 Leaky Bucket

```text
요청 → [ 큐(고정 크기) ] → 일정 속도로 처리
큐 가득 차면 drop
```

Token Bucket과의 본질적 차이:
- Token Bucket: **input은 burst 허용**, output 평균만 제한
- Leaky Bucket: **output 속도 자체가 일정** → 다운스트림이 일정 부하만 받음

Nginx `limit_req`가 정확히 이 모델:
```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
location /api/ {
    limit_req zone=api burst=20 nodelay;
}
```
- `rate=10r/s`: 초당 10개씩 빠지는 leaky bucket
- `burst=20`: 큐 깊이
- `nodelay`: 대기 없이 즉시 처리하되 큐 한도 초과 시 drop

### 3.3 Fixed Window

```text
[ 0~59초 ] 카운터 = 0, 요청마다 +1, 60 초과 시 차단
[ 60초 도달 ] 카운터 리셋
```

Redis 한 줄:
```bash
INCR user:123:1714186800   # 키에 분 단위 timestamp
EXPIRE user:123:1714186800 60
```

**치명적 결함 — 경계 burst 문제**:
- 정책: "1분에 60회"
- 11:00:59에 60번 호출 (이번 분 한도 채움)
- 11:01:00에 또 60번 호출 (새 분 시작)
- 결과: **2초 사이에 120번 통과**. 실질 RPS 60이 아니라 60/sec burst를 허용한 셈.

### 3.4 Sliding Window Log

요청 timestamp를 모두 저장하고, 윈도우 밖은 버림.

```python
# Redis Sorted Set 활용
key = f"ratelimit:{user_id}"
now = time.time()
window = 60  # 1분

pipe = redis.pipeline()
pipe.zremrangebyscore(key, 0, now - window)  # 오래된 거 제거
pipe.zcard(key)                               # 현재 카운트
pipe.zadd(key, {str(uuid.uuid4()): now})      # 이번 요청 추가
pipe.expire(key, window)
_, count, _, _ = pipe.execute()

if count >= 60:
    return DENY
return ALLOW
```

**장점**: 100% 정확
**단점**: 요청마다 timestamp 저장 → **메모리 O(허용 개수 × 사용자 수)**

### 3.5 Sliding Window Counter (가중 평균)

Fixed Window 2개를 가중 평균으로 보간:
```
이전 분 카운트: 80
현재 분 카운트: 30
현재 분 진행도: 25% (15초 / 60초)

추정 카운트 = 80 * (1 - 0.25) + 30
            = 60 + 30 = 90
```
1분에 60회 정책이라면 → 차단.

**장점**: 메모리 O(2) per user, 정확도 상위, Fixed Window 경계 burst 문제 해결
**단점**: 가중 평균이라 완벽한 정확도는 아님 (분포 가정)

---

## 4. 실무 매핑

| 시스템 | 알고리즘 | 이유 |
|---|---|---|
| **AWS API Gateway** | Token Bucket | `Burst limit` + `Rate limit` 두 파라미터가 정확히 token bucket 정의 |
| **Nginx `limit_req`** | Leaky Bucket | `rate` + `burst` 큐 |
| **Cloudflare Rate Limiting** | Sliding Window Counter | 대규모, 정확도, 메모리 효율 |
| **Kong API Gateway** | Sliding Window Counter (기본), Fixed/Sliding Log 옵션 | Redis 백엔드 |
| **GitHub API** | Token Bucket (시간당 5,000) | burst 허용 + steady rate |
| **Redis 직접 구현** | 보통 Sliding Window (Sorted Set) | 정확한 per-user 카운트 |
| **Envoy/Istio** | Token Bucket | 사이드카 레벨 throttle |

---

## 5. 이번 챌린지(트래픽 100배 + 중복 주문)에 적용

### 두 종류의 Rate Limit이 필요하다

1. **글로벌 트래픽 보호** (인프라 살리기)
   - 위치: API Gateway
   - 알고리즘: **Token Bucket** (burst 허용으로 정상 트래픽 영향 최소화)
   - 단위: IP 또는 전체 RPS

2. **중복 주문 방지** (비즈니스 로직 보호)
   - 위치: 애플리케이션 / Redis
   - 알고리즘: **Sliding Window** (Sorted Set 기반)
   - 단위: `user_id` 기준 "1분에 결제 시도 N회"

### 왜 API Gateway의 Token Bucket으로는 중복 주문을 못 잡나

- Token Bucket은 burst를 허용한다 → 사용자가 결제 버튼 5번 연타하면 5번 다 통과
- Token Bucket은 보통 **IP 또는 API Key 단위** → 동일 사용자가 여러 디바이스 또는 IP 변경 시 우회
- "1분 동안 정확히 N회"라는 비즈니스 룰을 표현 못 함 (token bucket은 "평균 r r/s + burst b" 모델)

**결론**: 인프라 보호용 Token Bucket과 비즈니스 룰용 Sliding Window는 **레이어가 다르다.** 둘 다 필요하다.

### 진짜 중복 주문 방지의 정답

Rate Limiting은 1차 방어일 뿐이다. **본질은 idempotency key**다.
- 클라이언트가 `Idempotency-Key: <uuid>` 헤더 전송
- 서버는 Redis `SET key value NX EX 600`으로 첫 요청만 처리
- Sliding Window는 "악의적 연타 방어", Idempotency Key는 "정상 사용자의 네트워크 재시도 보호"

---

## 6. 면접 빈출 포인트

### Q1. "Fixed Window의 경계 burst 문제를 설명해주세요."
A. 정책이 "1분에 60회"일 때, 11:00:59에 60번 + 11:01:00에 60번 → 약 1초 사이에 120번 통과. 윈도우 경계 부근에서 정책 의도(60 RPM)를 2배 위반할 수 있다. Sliding Window Counter로 해결.

### Q2. "Token Bucket과 Leaky Bucket의 본질적 차이는?"
A. **Burst 허용 여부**. Token Bucket은 토큰이 쌓인 만큼 burst 통과, 평균만 제한. Leaky Bucket은 출구 속도 자체가 고정이라 입력이 아무리 몰려도 다운스트림은 일정 부하만 받음. 다운스트림 보호엔 Leaky Bucket, 클라이언트 친화엔 Token Bucket.

### Q3. "분산 환경에서 Rate Limiter는 어떻게 구현하나요?"
A. 중앙 저장소 필요. Redis가 표준. **Lua 스크립트로 atomic하게** check-and-decrement. INCR + EXPIRE 같은 다중 명령은 race condition 가능 → Lua 또는 `MULTI/EXEC`. 또는 Redis 7+의 `CL.THROTTLE` (RedisCell 모듈, GCRA 알고리즘).

### Q4. "단일 Redis 장애 시 Rate Limiter는?"
A. 옵션 두 가지:
- **Fail-open**: Redis 장애 시 모든 요청 통과 (가용성 우선, 보안 약화)
- **Fail-closed**: 차단 (보안 우선, 가용성 약화)
- 일반적으로 비즈니스 임계도에 따라 결정. 결제는 fail-closed, 단순 read API는 fail-open이 흔함.

### Q5. "GCRA(Generic Cell Rate Algorithm) 들어보셨어요?"
A. Token Bucket의 메모리 효율 버전. 토큰 카운트 대신 **TAT(Theoretical Arrival Time)** 한 개만 저장. Redis Cell 모듈, Stripe 내부 구현이 사용. O(1) 메모리.

---

## 7. 이걸 모르면 어떻게 털리는가

**시니어 면접 실패 시나리오**:

> 면접관: "주문 API에 Rate Limit 어떻게 거실 거예요?"
> 후보자: "Redis로 카운트 해서 막습니다."
> 면접관: "어떤 알고리즘으로요?"
> 후보자: "음... INCR로 카운트해서 60 넘으면 막습니다."
> 면접관: "그게 Fixed Window인 건 아시죠? 11:00:59와 11:01:00 사이 burst는 어떻게 막나요?"
> 후보자: "..."
> 면접관: "그리고 그 정책이 user 단위인가요 IP 단위인가요? 둘 다 필요한 건 아닌가요?"
> 후보자: "..."
> 면접관: "Redis 죽으면요?"
> 후보자: "..."

**합격 답변**:

> "두 레이어로 나눕니다. (1) API Gateway에서 IP/API Key 단위 **Token Bucket**으로 인프라 보호. burst 허용이라 정상 사용자 영향 최소. (2) 애플리케이션에서 user_id 단위 **Sliding Window Counter** (Redis Sorted Set + Lua 스크립트)로 비즈니스 룰 적용. 중복 주문은 추가로 **Idempotency Key** 패턴으로 방어. Redis 장애 시 결제는 fail-closed, 조회는 fail-open. 더 큰 스케일이라면 GCRA로 메모리 절감."

이 차이가 시니어와 미들의 갈림길이다.

---

## 8. 추가 학습 포인트

- **GCRA (Generic Cell Rate Algorithm)**: 통신업계 표준, Token Bucket의 변형
- **Distributed Rate Limiting의 일관성**: 멀티 리전에서는 **약한 일관성** 허용 (eventual)
- **Backpressure vs Rate Limiting**: Rate Limit은 거절, Backpressure는 producer를 늦춤
- **Adaptive Rate Limiting**: 다운스트림 latency 기반 동적 조절 (Netflix Concurrency Limits 라이브러리)
- **429 Too Many Requests** + `Retry-After` 헤더는 표준. 504/503으로 응답하면 안 됨.

---

## 9. 챌린지 즉시 적용 체크리스트

- [ ] API Gateway에 IP 단위 Token Bucket (burst 200, rate 50/s)
- [ ] 결제 API에 user_id 단위 Sliding Window (1분에 5회)
- [ ] `Idempotency-Key` 헤더 검증 미들웨어
- [ ] Redis Lua 스크립트로 atomic check-and-decrement
- [ ] Redis 장애 시 결제 fail-closed 정책 결정
- [ ] 429 응답 시 `Retry-After` 헤더 포함
- [ ] 메트릭: 거절 비율, 사용자당 차단 횟수, Redis 응답 시간
