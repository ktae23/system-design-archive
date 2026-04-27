# 트랜잭션 격리 수준 (Transaction Isolation Level)

## 왜 지금 이 이론인가

트래픽이 100배 급증하면 동시에 수천 개의 트랜잭션이 같은 데이터를 읽고 쓴다. "사용자 A가 재고를 읽었는데 사용자 B가 그 사이에 재고를 차감했다" -- 이때 A가 읽은 값이 유효한가? 격리 수준에 따라 중복 주문이 나올 수도, 안 나올 수도 있다. 이론이 아니라 돈이 걸린 문제다.

## 핵심 개념

### 1. ACID 중 I(Isolation)

트랜잭션은 다른 트랜잭션의 중간 상태를 볼 수 있는가? 격리 수준이란 "얼마나 볼 수 있게 허용할 것인가"의 설정이다. 격리를 강하게 하면 정합성은 좋아지지만 동시성(성능)이 떨어진다.

### 2. 네 가지 격리 수준 (SQL 표준)

| 격리 수준 | Dirty Read | Non-repeatable Read | Phantom Read |
|-----------|:----------:|:-------------------:|:------------:|
| **READ UNCOMMITTED** | O | O | O |
| **READ COMMITTED** | X | O | O |
| **REPEATABLE READ** | X | X | O (InnoDB는 X) |
| **SERIALIZABLE** | X | X | X |

### 3. 세 가지 이상 현상

- **Dirty Read**: 커밋되지 않은 데이터를 읽음. 트랜잭션이 롤백되면 없는 데이터를 읽은 셈
- **Non-repeatable Read**: 같은 SELECT를 두 번 했는데 결과가 다름 (다른 트랜잭션이 UPDATE/DELETE)
- **Phantom Read**: 같은 범위 SELECT를 두 번 했는데 행(row)이 추가됨 (다른 트랜잭션이 INSERT)

### 4. MySQL InnoDB의 특수성

MySQL의 기본 격리 수준은 **REPEATABLE READ**인데, InnoDB는 **MVCC(Multi-Version Concurrency Control)** 와 **Gap Lock**으로 Phantom Read까지 방지한다. 그래서 InnoDB의 REPEATABLE READ는 사실상 다른 DB의 SERIALIZABLE에 근접한다.

반면 PostgreSQL의 기본값은 **READ COMMITTED**다. 같은 코드라도 DB가 다르면 동작이 달라질 수 있다.

### 5. MVCC (Multi-Version Concurrency Control)

락을 최소화하면서 격리를 보장하는 핵심 메커니즘. 각 행의 여러 버전을 유지하고, 트랜잭션 시작 시점의 스냅샷을 기준으로 읽기를 수행한다.

- **Undo Log**: 변경 전 데이터를 보관. 다른 트랜잭션이 이전 버전을 읽을 수 있게 함
- **Read View**: 트랜잭션이 "어떤 버전까지 볼 수 있는가"를 결정하는 스냅샷

## 실제로 어떻게 쓰이나

### 시나리오: 트래픽 100배 상황에서 재고 차감

```sql
-- 트랜잭션 A (사용자 A의 주문)
START TRANSACTION;
SELECT quantity FROM stock WHERE product_id = 100; -- 결과: 1

-- 이 사이에 트랜잭션 B가 실행됨
-- 트랜잭션 B: UPDATE stock SET quantity = 0 WHERE product_id = 100; COMMIT;

UPDATE stock SET quantity = quantity - 1 WHERE product_id = 100;
-- READ COMMITTED: quantity = 0 - 1 = -1 (음수 재고!)
-- REPEATABLE READ + InnoDB: quantity = 0 - 1 = -1 (여전히 문제!)
COMMIT;
```

**잠깐, REPEATABLE READ에서도 문제가 생긴다고?** 그렇다. MVCC는 **읽기(SELECT)** 에 대해서만 스냅샷을 보장한다. **쓰기(UPDATE)** 는 항상 최신 데이터에 대해 실행된다. 이걸 모르면 면접에서 바로 탈락이다.

### 패턴 1: SELECT FOR UPDATE로 비관적 락

```java
@Transactional
public Order createOrder(Long productId, int quantity) {
    // SELECT FOR UPDATE: 이 행에 대한 쓰기 락을 잡음
    Stock stock = stockRepository.findByProductIdForUpdate(productId);

    if (stock.getQuantity() < quantity) {
        throw new OutOfStockException("재고 부족");
    }

    stock.decrease(quantity);
    return orderRepository.save(new Order(productId, quantity));
}
```

```java
// Repository
@Lock(LockModeType.PESSIMISTIC_WRITE)
@Query("SELECT s FROM Stock s WHERE s.productId = :productId")
Stock findByProductIdForUpdate(@Param("productId") Long productId);
```

SELECT FOR UPDATE는 해당 행에 배타 락(exclusive lock)을 걸어서, 다른 트랜잭션이 같은 행을 읽거나 수정하려면 대기해야 한다.

### 패턴 2: 낙관적 락 (Optimistic Lock)

```java
@Entity
public class Stock {
    @Id
    private Long id;

    private Long productId;
    private int quantity;

    @Version
    private Long version; // JPA가 자동으로 버전 체크

    public void decrease(int amount) {
        if (this.quantity < amount) {
            throw new OutOfStockException("재고 부족");
        }
        this.quantity -= amount;
    }
}
```

```java
@Transactional
public Order createOrderWithRetry(Long productId, int quantity) {
    int retryCount = 0;
    while (retryCount < 3) {
        try {
            Stock stock = stockRepository.findByProductId(productId);
            stock.decrease(quantity);
            stockRepository.save(stock); // version 불일치 시 예외
            return orderRepository.save(new Order(productId, quantity));
        } catch (OptimisticLockingFailureException e) {
            retryCount++;
            if (retryCount >= 3) throw e;
        }
    }
    throw new OrderException("주문 처리 실패");
}
```

트래픽이 100배인 상황에서 낙관적 락은 재시도 폭발(retry storm)을 일으킬 수 있다. 100명이 동시에 같은 재고를 차감하면 99명이 실패하고 재시도한다. 이 경우 비관적 락이나 분산 락이 더 적합하다.

### 패턴 3: 격리 수준 확인 및 변경

```sql
-- MySQL 현재 격리 수준 확인
SELECT @@transaction_isolation;
-- 결과: REPEATABLE-READ (MySQL 기본)

-- 세션 레벨 변경
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- 글로벌 변경 (my.cnf 권장)
-- [mysqld]
-- transaction-isolation = READ-COMMITTED
```

```sql
-- PostgreSQL 현재 격리 수준 확인
SHOW default_transaction_isolation;
-- 결과: read committed (PostgreSQL 기본)
```

### READ COMMITTED vs REPEATABLE READ: 실무 선택 기준

| 기준 | READ COMMITTED | REPEATABLE READ |
|------|---------------|-----------------|
| 기본 DB | PostgreSQL | MySQL InnoDB |
| 장기 트랜잭션 | 유리 (undo log 부담 적음) | 불리 (스냅샷 유지 비용) |
| 데이터 정합성 | 같은 쿼리 결과가 달라질 수 있음 | 트랜잭션 내 일관된 읽기 보장 |
| 동시성 | 높음 | 상대적으로 낮음 |
| 갭 락 | 없음 | 있음 (InnoDB) |

최근 트렌드는 MySQL에서도 READ COMMITTED로 낮추는 경우가 늘고 있다. 갭 락으로 인한 데드락이 줄어들기 때문이다.

## 면접에서 이렇게 털린다

### Q1. "REPEATABLE READ에서 Phantom Read가 발생하나요?"

**털리는 답변**: "네, SQL 표준에 따르면 발생합니다." (끝)

**살아남는 답변**: "SQL 표준에서는 REPEATABLE READ에서 Phantom Read가 가능하지만, MySQL InnoDB는 MVCC의 consistent read와 Gap Lock을 통해 REPEATABLE READ에서도 Phantom Read를 방지합니다. 다만 이는 InnoDB의 구현 특성이지 표준이 아니므로, 다른 DB(예: PostgreSQL)에서는 다르게 동작합니다."

### Q2. "SELECT와 SELECT FOR UPDATE의 차이를 설명해주세요."

**털리는 답변**: "SELECT FOR UPDATE는 락을 거는 겁니다." (너무 단순)

**살아남는 답변**: "일반 SELECT는 MVCC 스냅샷을 읽는 consistent read로, 락을 걸지 않습니다. SELECT FOR UPDATE는 locking read로, 해당 행에 exclusive lock을 걸어 다른 트랜잭션의 수정을 차단합니다. 특히 REPEATABLE READ에서도 일반 SELECT는 트랜잭션 시작 시점의 스냅샷을 읽지만, SELECT FOR UPDATE는 최신 커밋 데이터를 읽습니다. 재고 차감처럼 읽은 값 기반으로 수정해야 하는 경우에는 반드시 SELECT FOR UPDATE를 써야 합니다."

### Q3. "데드락이 왜 발생하고 어떻게 해결하나요?"

**살아남는 답변**: "두 트랜잭션이 서로가 잡고 있는 락을 기다리면 데드락이 발생합니다. InnoDB는 데드락을 감지하면 한쪽 트랜잭션을 자동 롤백합니다. 예방을 위해서는 모든 트랜잭션이 같은 순서로 리소스에 접근하도록 설계하고, 트랜잭션 범위를 최소화하며, 인덱스를 잘 설계하여 불필요한 락 범위를 줄여야 합니다. REPEATABLE READ의 Gap Lock이 데드락의 주범인 경우가 많아서, READ COMMITTED로 낮추는 것도 방법입니다."

## 더 깊이 파고들 포인트

1. **InnoDB의 락 구조 심화**: Record Lock, Gap Lock, Next-Key Lock의 차이와 동작 방식. `SHOW ENGINE INNODB STATUS`로 실제 락을 분석하는 방법.
2. **PostgreSQL의 MVCC와 MySQL의 MVCC 비교**: Undo Log 기반 vs Tuple 버전 관리. 각각의 vacuum/purge 메커니즘과 성능 특성.
3. **SSI (Serializable Snapshot Isolation)**: PostgreSQL의 SERIALIZABLE 구현 방식. 락 없이 직렬화 가능성을 검증하는 기법.
4. **Lost Update 문제**: 두 트랜잭션이 동시에 같은 값을 읽고 수정할 때 하나의 수정이 유실되는 문제. 격리 수준만으로 해결되지 않는 경우도 있다.
5. **분산 트랜잭션과 격리**: 2PC(Two-Phase Commit), Saga 패턴에서의 격리 보장. 단일 DB와는 완전히 다른 세계.
