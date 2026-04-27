# 분산 락 (Distributed Lock)

## 왜 지금 이 이론인가

트래픽이 100배 급증하면 수십 대의 서버 인스턴스가 동시에 같은 주문을 처리하려 든다. 단일 서버의 synchronized나 ReentrantLock은 그 서버 안에서만 동작하니까, 서버가 여러 대인 순간 무력해진다. "서버 A와 서버 B가 동시에 같은 재고를 차감했다" -- 이 문제를 풀려면 모든 서버가 바라보는 하나의 공유 락이 필요하다. 그게 분산 락이다.

## 핵심 개념

### 1. 분산 락이란

여러 프로세스(또는 서버 인스턴스)가 공유 자원에 동시 접근하는 것을 막기 위해, 외부 저장소(Redis, ZooKeeper 등)에 "이 자원은 내가 쓰고 있다"는 표시를 남기는 메커니즘이다.

### 2. Redis SETNX -- 분산 락의 기본 원리

```
SETNX lock:order:12345 "server-a-uuid"
```

- **SET if Not eXists**: 키가 없으면 설정하고 1 반환, 이미 있으면 0 반환
- 원자적(atomic) 연산이라 여러 서버가 동시에 시도해도 딱 하나만 성공한다
- 현대적 방식은 `SET key value NX EX 30` (설정 + 만료 시간을 한 번에)

### 3. 락의 3대 속성

| 속성 | 설명 |
|------|------|
| **상호 배제 (Mutual Exclusion)** | 한 시점에 하나의 클라이언트만 락을 보유 |
| **데드락 방지 (Deadlock Free)** | 락을 잡은 클라이언트가 죽어도 결국 락이 해제됨 (TTL) |
| **내결함성 (Fault Tolerance)** | Redis 노드 일부가 죽어도 락이 정상 동작 |

### 4. Redlock 알고리즘

Martin Kleppmann과 Salvatore Sanfilippo(Redis 창시자)의 유명한 논쟁 대상. Redis 단일 노드 락의 한계(마스터 장애 시 락 유실)를 보완하기 위해 N개(보통 5개) 독립 Redis 노드에 과반수 이상 락을 획득하는 방식이다.

**하지만** 실무에서는 Redlock보다 단일 Redis + TTL, 또는 Redisson 라이브러리를 쓰는 경우가 압도적으로 많다.

### 5. Redisson -- 실무의 표준

Java/Kotlin 진영에서 Redis 기반 분산 락의 사실상 표준 라이브러리. 락 획득 대기, 자동 연장(watchdog), 재진입(reentrant) 등 실무에 필요한 기능을 다 제공한다.

## 실제로 어떻게 쓰이나

### 패턴 1: Redis SETNX 직접 구현 (원리 이해용)

```java
public boolean tryLock(String lockKey, String requestId, long expireSeconds) {
    Boolean result = redisTemplate.opsForValue()
        .setIfAbsent(lockKey, requestId, Duration.ofSeconds(expireSeconds));
    return Boolean.TRUE.equals(result);
}

public void unlock(String lockKey, String requestId) {
    // Lua 스크립트로 원자적 해제 -- 내가 잡은 락만 해제
    String script =
        "if redis.call('get', KEYS[1]) == ARGV[1] then " +
        "   return redis.call('del', KEYS[1]) " +
        "else " +
        "   return 0 " +
        "end";
    redisTemplate.execute(
        new DefaultRedisScript<>(script, Long.class),
        List.of(lockKey),
        requestId
    );
}
```

**왜 Lua 스크립트를 쓰나?** GET으로 확인하고 DEL로 삭제하는 사이에 다른 서버가 끼어들 수 있다. Lua 스크립트는 Redis에서 원자적으로 실행되니까 이 race condition을 막는다.

### 패턴 2: Redisson 실무 적용

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final RedissonClient redissonClient;
    private final OrderRepository orderRepository;

    public Order createOrder(Long userId, OrderRequest request) {
        String lockKey = "lock:order:" + userId;
        RLock lock = redissonClient.getLock(lockKey);

        try {
            // 최대 5초 대기, 락 획득 후 10초 자동 해제
            boolean acquired = lock.tryLock(5, 10, TimeUnit.SECONDS);
            if (!acquired) {
                throw new OrderException("주문 처리 중입니다. 잠시 후 다시 시도해주세요.");
            }

            // 크리티컬 섹션: 재고 확인 + 주문 생성
            Stock stock = stockRepository.findByProductId(request.getProductId());
            if (stock.getQuantity() < request.getQuantity()) {
                throw new OutOfStockException("재고가 부족합니다.");
            }

            stock.decrease(request.getQuantity());
            return orderRepository.save(new Order(userId, request));

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new OrderException("주문 처리가 중단되었습니다.");
        } finally {
            if (lock.isHeldByCurrentThread()) {
                lock.unlock();
            }
        }
    }
}
```

### 패턴 3: AOP로 분산 락 횡단 관심사 분리

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface DistributedLock {
    String key();           // SpEL 지원: "#userId"
    long waitTime() default 5;
    long leaseTime() default 10;
    TimeUnit timeUnit() default TimeUnit.SECONDS;
}

@Aspect
@Component
@RequiredArgsConstructor
public class DistributedLockAspect {

    private final RedissonClient redissonClient;

    @Around("@annotation(distributedLock)")
    public Object around(ProceedingJoinPoint joinPoint,
                         DistributedLock distributedLock) throws Throwable {
        String key = parseKey(distributedLock.key(), joinPoint);
        RLock lock = redissonClient.getLock(key);

        try {
            boolean acquired = lock.tryLock(
                distributedLock.waitTime(),
                distributedLock.leaseTime(),
                distributedLock.timeUnit()
            );
            if (!acquired) {
                throw new LockAcquisitionException("락 획득 실패: " + key);
            }
            return joinPoint.proceed();
        } finally {
            if (lock.isHeldByCurrentThread()) {
                lock.unlock();
            }
        }
    }
}

// 사용
@DistributedLock(key = "'lock:order:' + #userId")
public Order createOrder(Long userId, OrderRequest request) {
    // 비즈니스 로직만 집중
}
```

### 분산 락 vs 낙관적 락 vs 비관적 락

| 방식 | 위치 | 충돌이 적을 때 | 충돌이 많을 때 |
|------|------|--------------|--------------|
| 낙관적 락 (Optimistic) | DB (version 컬럼) | 성능 좋음 | 재시도 폭발 |
| 비관적 락 (Pessimistic) | DB (SELECT FOR UPDATE) | 오버헤드 있음 | 안정적이나 DB 부하 |
| 분산 락 | Redis/ZooKeeper | 네트워크 오버헤드 | DB 부하 없이 안정적 |

트래픽 100배 상황에서는 **낙관적 락은 재시도가 폭발**하고, **비관적 락은 DB 커넥션을 오래 점유**한다. 그래서 분산 락이 트래픽 급증 시나리오에 적합한 선택인 거다.

## 면접에서 이렇게 털린다

### Q1. "분산 환경에서 동시성 제어를 어떻게 하시겠습니까?"

**털리는 답변**: "synchronized 쓰면 되지 않나요?" 또는 "DB에 SELECT FOR UPDATE 걸면 됩니다."

**살아남는 답변**: "서버가 여러 대인 환경에서는 JVM 레벨 락은 의미가 없습니다. Redis 기반 분산 락으로 서버 간 상호 배제를 보장하고, Redisson의 tryLock으로 대기 시간과 자동 해제 시간을 설정합니다. 다만 분산 락은 Redis 장애 시 SPOF가 될 수 있으므로, 비즈니스 크리티컬도에 따라 DB 비관적 락을 fallback으로 두는 것도 고려합니다."

### Q2. "분산 락의 TTL을 어떻게 설정하시겠습니까? 비즈니스 로직이 TTL보다 오래 걸리면?"

**털리는 답변**: "TTL을 넉넉하게 잡으면 되지 않나요?"

**살아남는 답변**: "TTL을 너무 길게 잡으면 장애 시 락이 오래 풀리지 않고, 너무 짧으면 비즈니스 로직 도중 락이 풀려서 다른 서버가 진입할 수 있습니다. Redisson은 watchdog 메커니즘으로 락을 보유한 스레드가 살아있는 동안 TTL을 자동 연장합니다. leaseTime을 지정하지 않으면 기본 30초 TTL로 시작하되 10초마다 갱신합니다."

### Q3. "Redis 마스터가 죽으면 분산 락은 어떻게 되나요?"

**살아남는 답변**: "Redis Sentinel이나 Cluster 환경에서 마스터 장애 후 복제가 완료되기 전에 페일오버되면, 새 마스터에는 락 정보가 없어서 다른 클라이언트가 같은 락을 획득할 수 있습니다. 이를 방지하려면 Redlock 알고리즘으로 과반수 노드에 락을 획득하거나, 락 유실 가능성을 감안하여 DB 레벨에서 추가적인 정합성 검증(멱등성 키 UNIQUE 제약 등)을 두는 이중 방어가 필요합니다."

## 더 깊이 파고들 포인트

1. **Redlock 논쟁**: Martin Kleppmann의 "How to do distributed locking" 글과 Salvatore의 반박. 분산 시스템의 시간(clock) 가정에 대한 깊은 통찰을 준다.
2. **Fencing Token**: 락 유실 상황에서도 데이터 정합성을 보장하는 기법. 락을 획득할 때마다 단조 증가하는 토큰을 발급하고, 저장소가 오래된 토큰의 쓰기를 거부한다.
3. **ZooKeeper 기반 분산 락**: 순서 보장이 있는 ephemeral sequential 노드를 활용. Redis보다 강한 일관성 보장이 필요할 때 선택지.
4. **etcd를 이용한 분산 락**: Kubernetes 환경에서는 이미 etcd가 있으니 이를 활용한 분산 락도 고려할 만하다.
5. **분산 락 없이 해결하기**: 모든 동시성 문제에 분산 락이 정답은 아니다. 메시지 큐 파티셔닝으로 같은 키의 이벤트를 같은 컨슈머가 처리하게 하면 락 없이도 직렬화가 가능하다.
