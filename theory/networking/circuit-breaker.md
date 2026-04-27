# 서킷 브레이커 (Circuit Breaker)

## 왜 지금 이 이론인가

트래픽이 100배 급증하면 주문 서비스만 터지는 게 아니다. 주문 서비스가 호출하는 결제 서비스, 재고 서비스, 알림 서비스까지 연쇄적으로 무너진다. 한 서비스의 응답 지연이 호출자의 스레드를 점유하고, 그 호출자를 호출하는 상위 서비스까지 타임아웃이 전파된다. 이걸 **장애 연쇄(Cascading Failure)** 라 하고, 이걸 끊어내는 패턴이 서킷 브레이커다.

## 핵심 개념

### 1. 전기 차단기에서 따온 이름

집에 과전류가 흐르면 두꺼비집(차단기)이 내려가서 전체 화재를 막는다. 소프트웨어에서도 마찬가지 -- 특정 서비스 호출이 반복적으로 실패하면 "더 이상 호출하지 않겠다"고 차단해서 전체 시스템을 보호한다.

### 2. 세 가지 상태

```
         실패율 임계치 초과
  [CLOSED] ──────────────→ [OPEN]
     ↑                        │
     │ 성공                    │ 대기 시간 경과
     │                        ↓
     └───────────────── [HALF-OPEN]
                          일부 요청만 통과시켜 테스트
```

| 상태 | 동작 |
|------|------|
| **CLOSED** (정상) | 요청을 그대로 통과시킴. 실패를 카운트. |
| **OPEN** (차단) | 요청을 즉시 거부(fallback 반환). 대상 서비스를 호출하지 않음. |
| **HALF-OPEN** (테스트) | 일부 요청만 통과시켜 복구 여부 확인. 성공하면 CLOSED, 실패하면 다시 OPEN. |

### 3. 핵심 설정값

| 설정 | 의미 | 예시 |
|------|------|------|
| `failureRateThreshold` | OPEN으로 전환하는 실패율 | 50% |
| `slowCallRateThreshold` | 느린 호출 비율 임계치 | 80% |
| `slowCallDurationThreshold` | "느린 호출"의 기준 시간 | 3초 |
| `slidingWindowSize` | 실패율 계산에 사용할 최근 호출 수 | 100 |
| `waitDurationInOpenState` | OPEN 상태 유지 시간 | 30초 |
| `permittedNumberOfCallsInHalfOpenState` | HALF-OPEN에서 테스트할 요청 수 | 5 |

### 4. Fallback -- 차단 시 대안

서킷이 열리면 에러를 그대로 던지지 않는다. 사용자 경험을 위한 대안(fallback)을 제공한다:

- 캐시된 이전 데이터 반환
- 기본값 반환
- 다른 서비스로 우회
- 사용자에게 "잠시 후 다시 시도해주세요" 안내

### 5. 서킷 브레이커 vs Retry vs Timeout

| 패턴 | 목적 | 위험 |
|------|------|------|
| **Timeout** | 무한 대기 방지 | 타임아웃 값이 길면 스레드 점유 |
| **Retry** | 일시적 오류 복구 | 재시도 폭풍(retry storm) |
| **Circuit Breaker** | 지속적 장애에서 시스템 보호 | Fallback이 부실하면 사용자 경험 저하 |

이 셋은 경쟁 관계가 아니라 **조합**해서 쓴다: Timeout 설정 + 실패 시 Retry(최대 3회) + 반복 실패 시 Circuit Breaker OPEN.

## 실제로 어떻게 쓰이나

### 패턴 1: Resilience4j 기본 적용

```java
// build.gradle
// implementation 'io.github.resilience4j:resilience4j-spring-boot3:2.1.0'
```

```yaml
# application.yml
resilience4j:
  circuitbreaker:
    instances:
      paymentService:
        failure-rate-threshold: 50
        slow-call-rate-threshold: 80
        slow-call-duration-threshold: 3s
        sliding-window-type: COUNT_BASED
        sliding-window-size: 100
        minimum-number-of-calls: 10
        wait-duration-in-open-state: 30s
        permitted-number-of-calls-in-half-open-state: 5
        record-exceptions:
          - java.io.IOException
          - java.util.concurrent.TimeoutException
        ignore-exceptions:
          - com.example.BusinessException  # 비즈니스 예외는 장애가 아님
```

```java
@Service
@RequiredArgsConstructor
public class OrderService {

    private final PaymentClient paymentClient;

    @CircuitBreaker(name = "paymentService", fallbackMethod = "paymentFallback")
    public PaymentResult processPayment(PaymentRequest request) {
        return paymentClient.charge(request);
    }

    // Fallback: 서킷 OPEN 시 또는 예외 발생 시 호출
    private PaymentResult paymentFallback(PaymentRequest request, Throwable t) {
        log.warn("결제 서비스 장애, fallback 실행: {}", t.getMessage());

        // 주문을 "결제 대기" 상태로 저장하고 나중에 재처리
        orderRepository.savePendingPayment(request);

        return PaymentResult.pending("결제 처리가 지연되고 있습니다. "
            + "잠시 후 자동으로 처리됩니다.");
    }
}
```

### 패턴 2: 서킷 브레이커 + Retry + Timeout 조합

```java
@Service
public class InventoryService {

    @CircuitBreaker(name = "inventoryService", fallbackMethod = "inventoryFallback")
    @Retry(name = "inventoryService")
    @TimeLimiter(name = "inventoryService")
    public CompletableFuture<StockResult> checkStock(Long productId) {
        return CompletableFuture.supplyAsync(() ->
            inventoryClient.getStock(productId)
        );
    }

    private CompletableFuture<StockResult> inventoryFallback(
            Long productId, Throwable t) {
        // 재고 서비스 장애 시 캐시된 재고 정보 반환
        return CompletableFuture.completedFuture(
            stockCacheService.getCachedStock(productId)
        );
    }
}
```

```yaml
resilience4j:
  retry:
    instances:
      inventoryService:
        max-attempts: 3
        wait-duration: 500ms
        retry-exceptions:
          - java.io.IOException
  timelimiter:
    instances:
      inventoryService:
        timeout-duration: 2s
```

**실행 순서**: TimeLimiter(2초 타임아웃) -> Retry(최대 3회) -> CircuitBreaker(실패율 체크). 어노테이션은 위에서 아래로 적용되지만, 실행은 바깥(CircuitBreaker)에서 안쪽(TimeLimiter)으로 감싼다.

### 패턴 3: 서킷 브레이커 상태 모니터링

```java
@Component
@RequiredArgsConstructor
public class CircuitBreakerMonitor {

    private final CircuitBreakerRegistry circuitBreakerRegistry;

    @PostConstruct
    public void registerEventListeners() {
        circuitBreakerRegistry.getAllCircuitBreakers().forEach(cb -> {
            cb.getEventPublisher()
                .onStateTransition(event ->
                    log.warn("[Circuit Breaker] {} 상태 변경: {} -> {}",
                        event.getCircuitBreakerName(),
                        event.getStateTransition().getFromState(),
                        event.getStateTransition().getToState()))
                .onFailureRateExceeded(event ->
                    log.error("[Circuit Breaker] {} 실패율 초과: {}%",
                        event.getCircuitBreakerName(),
                        event.getFailureRate()))
                .onSlowCallRateExceeded(event ->
                    log.error("[Circuit Breaker] {} 느린 호출율 초과: {}%",
                        event.getCircuitBreakerName(),
                        event.getSlowCallRate()));
        });
    }
}
```

Actuator 엔드포인트(`/actuator/circuitbreakers`)와 Prometheus 메트릭(`resilience4j_circuitbreaker_state`)을 Grafana에 연결하면 실시간으로 서킷 상태를 확인할 수 있다.

### 장애 연쇄 시나리오 (서킷 브레이커 없을 때)

```
1. 결제 서비스 응답 지연 (DB 과부하)
2. 주문 서비스의 스레드가 결제 응답 대기 (타임아웃 30초)
3. 주문 서비스 스레드 풀 고갈
4. 주문 서비스 응답 불가
5. API Gateway에서 주문 서비스 호출 타임아웃
6. 프론트엔드 타임아웃 → 사용자가 재시도 → 트래픽 더 증가
7. 결제 서비스뿐 아니라 전체 플랫폼 다운
```

서킷 브레이커가 있으면 2단계에서 차단: 결제 호출을 즉시 실패시키고, 주문을 "결제 대기" 상태로 저장. 나머지 서비스는 정상 동작.

## 면접에서 이렇게 털린다

### Q1. "마이크로서비스 환경에서 장애 전파를 어떻게 막으시겠습니까?"

**털리는 답변**: "타임아웃을 짧게 설정합니다." (그것만으론 부족)

**살아남는 답변**: "타임아웃으로 무한 대기를 방지하고, 실패 시 제한적 재시도를 하되, 반복적 실패가 감지되면 서킷 브레이커로 해당 서비스 호출을 차단합니다. Resilience4j의 CircuitBreaker를 사용하여 실패율 50% 초과 시 OPEN 상태로 전환하고, Fallback으로 캐시 데이터 반환이나 비동기 재처리를 제공합니다. 추가로 Bulkhead 패턴으로 서비스별 스레드 풀을 격리하여, 하나의 느린 서비스가 전체 스레드 풀을 잡아먹는 것을 방지합니다."

### Q2. "서킷 브레이커의 세 가지 상태를 설명하고, HALF-OPEN이 왜 필요한지 말해주세요."

**털리는 답변**: "CLOSED, OPEN, HALF-OPEN이 있고... HALF-OPEN은 중간 단계입니다." (의미 없는 답)

**살아남는 답변**: "CLOSED는 정상 동작, OPEN은 차단 상태입니다. HALF-OPEN은 복구 감지를 위한 상태로, 일정 시간 경과 후 소수의 요청만 통과시켜 대상 서비스가 회복되었는지 테스트합니다. HALF-OPEN 없이 OPEN에서 바로 CLOSED로 가면, 아직 복구되지 않은 서비스에 전체 트래픽이 쏟아져서 다시 장애가 발생합니다. HALF-OPEN은 점진적 복구(graceful recovery)를 가능하게 합니다."

### Q3. "서킷 브레이커와 Retry를 같이 쓸 때 주의할 점은?"

**살아남는 답변**: "Retry가 서킷 브레이커 안쪽에 있어야 합니다. 즉, 재시도를 다 한 후에도 실패하면 그때 서킷 브레이커의 실패로 카운트되어야 합니다. 반대로 서킷 브레이커 바깥에 Retry가 있으면, 서킷이 OPEN인데도 재시도를 시도하게 되어 의미가 없습니다. 또한 Retry의 최대 횟수와 backoff를 적절히 설정하지 않으면 재시도 폭풍(retry storm)이 발생하여 장애를 악화시킬 수 있습니다."

## 더 깊이 파고들 포인트

1. **Bulkhead Pattern**: 서비스별 스레드 풀을 격리하여 한 서비스의 장애가 다른 서비스 호출에 영향을 주지 않도록 하는 패턴. 서킷 브레이커와 함께 쓰면 방어가 이중으로 강화된다.
2. **Rate Limiter**: 초당 요청 수를 제한하여 서비스를 보호. 서킷 브레이커가 "이미 터진 후" 차단이라면, Rate Limiter는 "터지기 전에" 제한.
3. **Service Mesh와 서킷 브레이커**: Istio, Linkerd 같은 서비스 메시에서 애플리케이션 코드 수정 없이 인프라 레벨에서 서킷 브레이커를 적용하는 방법.
4. **Chaos Engineering**: Netflix의 Chaos Monkey처럼 의도적으로 장애를 주입하여 서킷 브레이커가 제대로 동작하는지 검증하는 방법론.
5. **Adaptive Circuit Breaker**: 고정 임계치 대신 트래픽 패턴에 따라 동적으로 임계치를 조절하는 고급 패턴. 평소 트래픽과 피크 타임에 다른 전략을 적용.
