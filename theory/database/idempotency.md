# 멱등성 (Idempotency)

## 왜 지금 이 이론인가

트래픽이 100배 급증하면 네트워크 타임아웃과 재시도가 폭발적으로 늘어난다. 이때 "같은 주문 요청이 두 번 들어왔을 때 주문이 두 건 생기느냐, 한 건만 생기느냐"를 결정하는 게 바로 멱등성이다. 중복 주문 사고의 근본 원인은 대부분 멱등성 설계가 빠져 있기 때문이다.

## 핵심 개념

### 1. 정의: 같은 연산을 여러 번 수행해도 결과가 동일하다

수학에서 온 개념이다. `f(f(x)) = f(x)`. HTTP 메서드로 보면:

| 메서드 | 멱등? | 설명 |
|--------|-------|------|
| GET | O | 조회는 몇 번을 해도 같다 |
| PUT | O | 같은 데이터로 덮어쓰기, 결과 동일 |
| DELETE | O | 이미 삭제된 걸 또 삭제해도 "없음"은 동일 |
| POST | **X** | 호출할 때마다 새 리소스가 생길 수 있다 |

POST가 멱등하지 않기 때문에 주문 생성(POST /orders)에서 중복이 터지는 거다.

### 2. Idempotency Key

클라이언트가 요청마다 고유한 키(UUID 등)를 생성해서 서버에 함께 보낸다. 서버는 이 키로 "이미 처리한 요청인가?"를 판별한다. Stripe, Toss 같은 결제 API가 전부 이 방식을 쓴다.

### 3. 멱등성의 범위

- **API 레벨**: Idempotency Key 헤더
- **DB 레벨**: UNIQUE 제약조건, UPSERT
- **메시지 큐 레벨**: Consumer의 중복 처리 방지 (Exactly-once vs At-least-once)

### 4. At-least-once + Idempotency = Exactly-once (사실상)

분산 시스템에서 진정한 Exactly-once delivery는 불가능에 가깝다. 그래서 실무에서는 "최소 한 번은 전달하되, 받는 쪽에서 중복을 걸러낸다"는 전략을 쓴다. 이게 바로 멱등성이 핵심인 이유다.

### 5. 멱등성 vs 동시성 제어

멱등성은 "같은 요청의 재시도"를 안전하게 만들고, 동시성 제어(락, 트랜잭션)는 "서로 다른 요청의 동시 접근"을 안전하게 만든다. 둘은 다른 문제를 푸는 거다. 중복 주문 방지에는 둘 다 필요하다.

## 실제로 어떻게 쓰이나

### 패턴 1: Idempotency Key + Redis 캐시

```java
@PostMapping("/orders")
public ResponseEntity<Order> createOrder(
        @RequestHeader("Idempotency-Key") String idempotencyKey,
        @RequestBody OrderRequest request) {

    // 1. Redis에서 이미 처리된 키인지 확인
    String cached = redisTemplate.opsForValue().get("idem:" + idempotencyKey);
    if (cached != null) {
        return ResponseEntity.ok(objectMapper.readValue(cached, Order.class));
    }

    // 2. 주문 생성
    Order order = orderService.create(request);

    // 3. 결과를 Redis에 저장 (TTL 24시간)
    redisTemplate.opsForValue().set(
        "idem:" + idempotencyKey,
        objectMapper.writeValueAsString(order),
        Duration.ofHours(24)
    );

    return ResponseEntity.status(HttpStatus.CREATED).body(order);
}
```

**주의**: 2번과 3번 사이에 서버가 죽으면? Redis에 저장 전에 크래시가 나면 다음 재시도 때 주문이 두 건 생긴다. 이걸 막으려면 DB 저장과 Redis 저장을 원자적으로 처리하거나, DB 자체에 idempotency key를 UNIQUE로 넣어야 한다.

### 패턴 2: DB UNIQUE 제약조건 활용

```sql
CREATE TABLE orders (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    idempotency_key VARCHAR(64) UNIQUE NOT NULL,
    user_id BIGINT NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

```java
try {
    orderRepository.save(order); // idempotency_key가 UNIQUE
} catch (DuplicateKeyException e) {
    // 이미 존재하는 주문 -> 기존 주문을 조회해서 반환
    return orderRepository.findByIdempotencyKey(idempotencyKey);
}
```

이 방식이 Redis보다 안전하다. DB 트랜잭션 안에서 원자적으로 처리되니까.

### 패턴 3: Kafka Consumer 멱등성

```java
@KafkaListener(topics = "order-events")
public void handleOrderEvent(ConsumerRecord<String, OrderEvent> record) {
    String eventId = record.key(); // 이벤트 고유 ID

    // 이미 처리한 이벤트인지 확인
    if (processedEventRepository.existsById(eventId)) {
        log.info("이미 처리된 이벤트, 스킵: {}", eventId);
        return;
    }

    // 비즈니스 로직 수행
    orderService.process(record.value());

    // 처리 완료 기록
    processedEventRepository.save(new ProcessedEvent(eventId));
}
```

## 면접에서 이렇게 털린다

### Q1. "POST API에서 중복 요청이 들어오면 어떻게 처리하시겠습니까?"

**털리는 답변**: "프론트에서 버튼 비활성화 처리합니다."
-> 면접관 속마음: "네트워크 재시도는? 로드밸런서 retry는? 큐 재처리는?"

**살아남는 답변**: "클라이언트에서 Idempotency Key를 생성하여 헤더에 담아 보내고, 서버에서는 해당 키를 DB UNIQUE 제약조건 또는 Redis를 활용하여 중복 여부를 판별합니다. 중복인 경우 기존 처리 결과를 그대로 반환하여 멱등성을 보장합니다. 특히 결제 같은 크리티컬한 도메인에서는 DB 레벨의 UNIQUE 제약이 더 안전합니다."

### Q2. "멱등성과 캐싱의 차이가 뭔가요?"

**털리는 답변**: "비슷한 거 아닌가요...?"

**살아남는 답변**: "캐싱은 성능 최적화가 목적이고, 멱등성은 데이터 정합성 보장이 목적입니다. 캐시는 만료되면 사라져도 괜찮지만, 멱등성 키가 너무 빨리 만료되면 중복 처리가 발생할 수 있어서 비즈니스 요구사항에 맞는 TTL 설정이 중요합니다."

### Q3. "Kafka에서 Exactly-once를 어떻게 보장하나요?"

**살아남는 답변**: "Kafka 자체의 Exactly-once semantics(idempotent producer + transactional API)도 있지만, Consumer 측에서는 메시지의 고유 ID를 기반으로 처리 여부를 기록하는 멱등성 패턴을 함께 적용해야 end-to-end Exactly-once에 가까워집니다. 진정한 Exactly-once는 이론적으로 불가능에 가깝기 때문에 At-least-once + 멱등성 조합이 실무 표준입니다."

## 더 깊이 파고들 포인트

1. **Outbox Pattern**: DB 트랜잭션과 메시지 발행의 원자성을 보장하는 패턴. 멱등성과 함께 쓰면 이벤트 기반 아키텍처에서 데이터 정합성이 견고해진다.
2. **CRDT (Conflict-free Replicated Data Type)**: 분산 환경에서 충돌 없이 데이터를 병합할 수 있는 자료구조. 멱등성의 수학적 확장이라 볼 수 있다.
3. **Saga Pattern**: 분산 트랜잭션에서 각 단계의 보상 트랜잭션(compensation)을 설계할 때, 각 단계가 멱등해야 안전한 롤백이 가능하다.
4. **Idempotency Key의 생명주기 관리**: TTL을 너무 짧게 잡으면 중복이 생기고, 너무 길면 저장소 비용이 증가한다. 도메인별 적정값을 어떻게 결정하는가?
5. **HTTP Conditional Requests**: ETag, If-Match 헤더를 활용한 멱등성 보장. REST API 설계의 심화 주제.
