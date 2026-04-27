# DB 커넥션 풀 (Connection Pool)

## 왜 지금 이 이론인가

트래픽이 100배 급증하면 가장 먼저 터지는 곳이 DB 커넥션이다. 요청마다 커넥션을 새로 맺으면 TCP 3-way handshake + DB 인증만으로도 수십 밀리초가 소모된다. 커넥션 풀이 고갈되면 애플리케이션은 "커넥션을 기다리다 타임아웃"으로 전부 멈춘다. 서버 CPU는 놀고 있는데 아무것도 처리 못하는 기이한 상황 -- 그게 커넥션 풀 고갈이다.

## 핵심 개념

### 1. 커넥션 풀이란

미리 일정 수의 DB 커넥션을 생성해서 풀(pool)에 보관하고, 요청이 올 때 빌려주고 끝나면 반납받는 구조다. 커넥션 생성/소멸 비용을 제거하고, 동시 커넥션 수를 제한하여 DB를 보호한다.

```
[App Server]
  Thread-1 → Pool에서 커넥션 빌림 → 쿼리 실행 → 반납
  Thread-2 → Pool에서 커넥션 빌림 → 쿼리 실행 → 반납
  Thread-3 → Pool 비었음 → 대기... → 타임아웃!
```

### 2. HikariCP -- Java 진영의 표준

Spring Boot 2.0부터 기본 커넥션 풀이 HikariCP다. "빠르고 가볍다"는 슬로건 그대로, 바이트코드 레벨 최적화로 다른 풀(DBCP2, Tomcat Pool) 대비 압도적 성능을 보인다.

핵심 설정값:

| 설정 | 기본값 | 의미 |
|------|--------|------|
| `maximumPoolSize` | 10 | 풀이 보유할 최대 커넥션 수 |
| `minimumIdle` | = maximumPoolSize | 유지할 최소 유휴 커넥션 수 |
| `connectionTimeout` | 30000ms | 커넥션을 기다릴 최대 시간 |
| `maxLifetime` | 1800000ms (30분) | 커넥션의 최대 수명 |
| `idleTimeout` | 600000ms (10분) | 유휴 커넥션 유지 시간 |

### 3. 커넥션 고갈의 원리

트래픽 100배 상황을 수치로 보면:

- 평소: 초당 100 요청, 각 쿼리 50ms → 동시 필요 커넥션 = 100 * 0.05 = **5개**
- 100배: 초당 10,000 요청, 각 쿼리 50ms → 동시 필요 커넥션 = 10,000 * 0.05 = **500개**

maximumPoolSize가 10이면? 490개 요청이 대기열에 쌓인다. connectionTimeout(30초)을 넘기면 `SQLTransientConnectionException`이 터진다. 그리고 대기 중인 스레드들이 톰캣 스레드 풀까지 먹어서 서버 전체가 멈춘다.

### 4. 커넥션 풀 크기 공식

HikariCP 공식 위키에서 제시하는 공식:

```
connections = ((core_count * 2) + effective_spindle_count)
```

- SSD라면 effective_spindle_count = 0으로 봐도 무방
- 4코어 서버라면: (4 * 2) + 0 = **8개**

"어? 8개밖에 안 돼?" 맞다. 커넥션 풀은 크다고 좋은 게 아니다. DB는 컨텍스트 스위칭 비용이 있어서, 커넥션이 너무 많으면 오히려 전체 처리량(throughput)이 떨어진다.

### 5. 커넥션 누수 (Connection Leak)

커넥션을 빌려가고 반납하지 않는 것. 트랜잭션이 커밋/롤백 없이 끝나거나, try-finally로 close를 보장하지 않으면 발생한다. 누수가 쌓이면 풀이 서서히 줄어들어 결국 고갈된다.

HikariCP의 `leakDetectionThreshold` 설정으로 누수를 감지할 수 있다 (기본 0, 비활성).

## 실제로 어떻게 쓰이나

### 패턴 1: Spring Boot HikariCP 튜닝

```yaml
# application.yml
spring:
  datasource:
    hikari:
      maximum-pool-size: 20          # DB 서버 스펙에 맞게
      minimum-idle: 10               # 급증 대비 워밍업
      connection-timeout: 3000       # 30초는 너무 길다, 3초로
      max-lifetime: 1800000          # DB의 wait_timeout보다 짧게
      idle-timeout: 600000
      leak-detection-threshold: 5000 # 5초 넘게 반납 안 하면 경고
      pool-name: OrderDB-Pool
```

**connection-timeout을 3초로 줄이는 이유**: 30초를 기다리는 동안 톰캣 스레드가 점유된다. 빠르게 실패(fail-fast)시키고 클라이언트에 재시도를 유도하는 게 전체 시스템 안정성에 낫다.

### 패턴 2: 커넥션 풀 모니터링

```java
@Component
@RequiredArgsConstructor
public class HikariMetrics {

    private final DataSource dataSource;

    @Scheduled(fixedRate = 10000)
    public void logPoolStats() {
        HikariPoolMXBean pool =
            ((HikariDataSource) dataSource).getHikariPoolMXBean();

        log.info("Pool Stats - Active: {}, Idle: {}, Waiting: {}, Total: {}",
            pool.getActiveConnections(),
            pool.getIdleConnections(),
            pool.getThreadsAwaitingConnection(),
            pool.getTotalConnections()
        );

        // 대기 스레드가 있으면 경고
        if (pool.getThreadsAwaitingConnection() > 0) {
            log.warn("커넥션 대기 발생! Waiting: {}",
                pool.getThreadsAwaitingConnection());
        }
    }
}
```

Grafana + Prometheus로 `hikaricp_connections_active`, `hikaricp_connections_pending` 메트릭을 대시보드에 올려놓는 게 실무 표준이다. 트래픽 급증 전에 대기가 발생하기 시작하면 그게 경고 신호다.

### 패턴 3: 읽기/쓰기 분리로 커넥션 분산

```java
@Configuration
public class DataSourceConfig {

    @Bean
    @ConfigurationProperties("spring.datasource.writer")
    public DataSource writerDataSource() {
        return DataSourceBuilder.create().type(HikariDataSource.class).build();
    }

    @Bean
    @ConfigurationProperties("spring.datasource.reader")
    public DataSource readerDataSource() {
        return DataSourceBuilder.create().type(HikariDataSource.class).build();
    }

    @Bean
    public DataSource routingDataSource(
            @Qualifier("writerDataSource") DataSource writer,
            @Qualifier("readerDataSource") DataSource reader) {
        ReplicationRoutingDataSource routing = new ReplicationRoutingDataSource();
        routing.setTargetDataSources(Map.of(
            "writer", writer,
            "reader", reader
        ));
        routing.setDefaultTargetDataSource(writer);
        return routing;
    }
}
```

주문 생성은 Writer DB로, 주문 조회는 Reader DB(Replica)로 보내면 커넥션 풀 압박이 반으로 줄어든다.

### 커넥션 고갈 시 벌어지는 일 (타임라인)

```
t=0s   트래픽 100배 시작
t=0.5s Active connections = maximumPoolSize (풀 포화)
t=1s   ThreadsAwaitingConnection 급증
t=3s   connectionTimeout 도달, SQLTransientConnectionException 발생
t=5s   톰캣 스레드 풀도 대기 스레드로 포화
t=10s  새 요청은 톰캣 큐에서 대기 → 502 Bad Gateway
t=30s  전체 서비스 무응답 상태
```

이 30초 안에 서킷 브레이커가 발동해야 하고, 오토스케일링이 시작되어야 한다.

## 면접에서 이렇게 털린다

### Q1. "커넥션 풀 크기를 어떻게 결정하시겠습니까?"

**털리는 답변**: "트래픽 많으면 크게 잡으면 되지 않나요? 100개 정도?"

**살아남는 답변**: "HikariCP 공식 위키의 공식 `(core_count * 2) + spindle_count`을 기준으로 시작합니다. DB 서버의 `max_connections`를 전체 애플리케이션 인스턴스 수로 나눈 것도 상한선이 됩니다. 예를 들어 DB max_connections가 200이고 앱 서버가 10대면, 인스턴스당 최대 20개가 상한입니다. 이후 부하 테스트로 처리량 대비 응답 시간의 sweet spot을 찾아 미세 조정합니다."

### Q2. "커넥션 풀이 고갈되면 어떻게 대응하시겠습니까?"

**털리는 답변**: "풀 크기를 늘립니다."

**살아남는 답변**: "단기적으로는 connection-timeout을 짧게(3초 이하) 설정하여 빠르게 실패시키고, 서킷 브레이커로 장애 전파를 차단합니다. 근본적으로는 슬로우 쿼리를 최적화하고, 읽기/쓰기 DataSource를 분리하며, 커넥션을 오래 잡는 트랜잭션 범위를 좁혀야 합니다. 풀 크기를 무작정 늘리면 DB 서버의 max_connections를 초과하거나 컨텍스트 스위칭 비용이 증가하여 오히려 성능이 하락합니다."

### Q3. "DB의 max_connections와 애플리케이션의 커넥션 풀 크기는 어떤 관계가 있나요?"

**살아남는 답변**: "DB의 max_connections는 물리적 한계이고, 앱의 커넥션 풀은 그 안에서의 할당량입니다. 앱 인스턴스가 N대이면 `N * maximumPoolSize <= DB max_connections`이어야 합니다. 여기에 관리용 커넥션(모니터링, 마이그레이션)을 위한 여유분도 남겨둬야 합니다. 오토스케일링으로 인스턴스가 늘어날 때 이 계산이 깨지는 사고가 실제로 자주 발생합니다."

## 더 깊이 파고들 포인트

1. **DB 서버 측 커넥션 관리**: MySQL의 `max_connections`, `wait_timeout`, `thread_pool` 설정. 애플리케이션 측만 알면 절반만 아는 거다.
2. **PgBouncer / ProxySQL**: DB 앞에 커넥션 풀링 프록시를 두는 패턴. 애플리케이션 레벨 풀과 조합하면 커넥션 관리가 더 효율적이 된다.
3. **Connection Pool과 트랜잭션 범위**: `@Transactional`이 걸린 메서드가 외부 API 호출을 포함하면, 그 응답 시간만큼 커넥션이 잡혀 있다. 트랜잭션 범위 설계가 커넥션 효율에 직결된다.
4. **R2DBC와 리액티브 커넥션 풀**: Non-blocking I/O 기반의 커넥션 관리. WebFlux 환경에서는 전통적 풀 대신 r2dbc-pool을 사용한다.
5. **Connection Warm-up**: 배포 직후 커넥션이 cold 상태라서 첫 요청들이 느린 현상. `minimumIdle` 설정과 health check 쿼리로 미리 워밍업하는 전략.
