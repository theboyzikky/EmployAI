//! Unit tests for the treasury contract v1 (offline, mocked NEAR environment).
//!
//! T-A1 … T-A13 are the asynchronous payment and callback tests from the M5 plan §6.5; the rest are
//! the contract security tests (owner-only and one-yocto methods, private init and callbacks, pause,
//! allowlist, caps, withdraw floor, disabled sales). The mocked environment does not execute real
//! transfers or protocol refunds: callbacks are driven with mocked promise results, and refunds are
//! proven on testnet later (S8).
use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{PromiseResult, testing_env};
use std::panic::{AssertUnwindSafe, catch_unwind};

const TREASURY: &str = "treasury.employai-demo.testnet";
const OWNER: &str = "employai-demo.testnet";
const AGENT: &str = "finance-agent.employai-demo.testnet";
const SUP1: &str = "supplier-1.employai-demo.testnet";
const SUP2: &str = "supplier-2.employai-demo.testnet";
const STRANGER: &str = "attacker.testnet";
const DAY: u64 = 20_400; // an arbitrary UTC day number

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn milli(m: u128) -> NearToken {
    NearToken::from_millinear(m)
}
fn yocto(y: u128) -> NearToken {
    NearToken::from_yoctonear(y)
}

/// A context on `day`, as `pred`, with `deposit`. Block height grows with the day so records differ.
fn context(pred: &str, deposit: NearToken, day: u64, balance: NearToken) -> near_sdk::VMContext {
    VMContextBuilder::new()
        .current_account_id(acc(TREASURY))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .attached_deposit(deposit)
        .block_timestamp(day * DAY_NS + 1_000)
        .block_height(day * 10)
        .account_balance(balance)
        .build()
}
fn ctx(pred: &str, deposit: NearToken, day: u64) {
    testing_env!(context(pred, deposit, day, NearToken::from_near(10)));
}
fn as_owner(day: u64) {
    ctx(OWNER, yocto(1), day);
}
fn as_agent(day: u64) {
    ctx(AGENT, ZERO, day);
}
/// Install a mocked environment whose callback sees exactly one promise result, keeping contract storage.
/// near-sdk 5.29.1 deprecates this helper in favour of `testing_env!` with five arguments, but that form
/// needs `near_parameters::RuntimeFeesConfig`, which near-sdk does not re-export (it would need a new
/// direct dev-dependency). Every use goes through this one function, so the one warning stays visible.
fn with_promise_result(context: near_sdk::VMContext, result: PromiseResult) {
    near_sdk::test_utils::testing_env_with_promise_results(context, result);
}

/// The callback context: the contract calling itself, with a mocked transfer result.
fn callback(day: u64, ok: bool) {
    let result = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    with_promise_result(context(TREASURY, ZERO, day, NearToken::from_near(10)), result);
}

/// Initialised as the plan's demo values: 0.1 NEAR per payment, 0.25 NEAR per day; two approved suppliers.
fn setup() -> Treasury {
    ctx(TREASURY, ZERO, DAY);
    let mut t = Treasury::new(acc(OWNER), Some(acc(AGENT)), milli(100), milli(250));
    as_owner(DAY);
    t.approve_recipient(acc(SUP1));
    t.approve_recipient(acc(SUP2));
    t
}

fn pay(t: &mut Treasury, id: &str, to: &str, amount: NearToken) {
    let _ = t.request_payment(id.to_string(), acc(to), amount);
}

/// Run `f`, expect a panic whose message contains `msg`.
fn expect_panic<F: FnOnce()>(msg: &str, f: F) {
    let err = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
    let text = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(text.contains(msg), "panic {text:?} does not contain {msg:?}");
}

fn events(kind: &str) -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<Value>(j).unwrap())
        .filter(|v| v["event"] == kind)
        .collect()
}

fn spent(t: &Treasury) -> NearToken {
    t.get_spent_today().spent
}

// =========================================================================== initialisation

#[test]
fn init_is_private_to_the_contract_account() {
    ctx(OWNER, ZERO, DAY);
    expect_panic("Only the contract itself", || {
        let _ = Treasury::new(acc(OWNER), Some(acc(AGENT)), milli(100), milli(250));
    });
}

#[test]
fn init_validates_limits() {
    ctx(TREASURY, ZERO, DAY);
    expect_panic("max_per_tx must be positive", || {
        let _ = Treasury::new(acc(OWNER), None, ZERO, milli(250));
    });
    expect_panic("max_per_tx must be <= daily_cap", || {
        let _ = Treasury::new(acc(OWNER), None, milli(300), milli(250));
    });
}

#[test]
fn init_defaults_sales_disabled_not_paused() {
    let t = setup();
    let p = t.get_policy();
    assert_eq!(p.owner, acc(OWNER));
    assert_eq!(p.agent, Some(acc(AGENT)));
    assert_eq!((p.max_per_tx, p.daily_cap), (milli(100), milli(250)));
    assert!(!p.paused && !p.sales_enabled);
    assert_eq!(t.get_sales_config(), SalesConfig { enabled: false, contributors: None, split_bps: 0, min_order: ZERO });
    assert_eq!(spent(&t), ZERO);
}

// =========================================================================== owner methods

#[test]
fn owner_methods_reject_non_owners() {
    let mut t = setup();
    for who in [AGENT, STRANGER, SUP1] {
        ctx(who, yocto(1), DAY);
        expect_panic("Only owner", || t.approve_recipient(acc(STRANGER)));
        expect_panic("Only owner", || t.set_policy(milli(1_000), milli(1_000)));
        expect_panic("Only owner", || t.set_agent(Some(acc(STRANGER))));
        expect_panic("Only owner", || t.pause());
        expect_panic("Only owner", || t.unpause());
        expect_panic("Only owner", || t.remove_recipient(acc(SUP1)));
        expect_panic("Only owner", || {
            let _ = t.withdraw(milli(1));
        });
        expect_panic("Only owner", || t.set_sales(true, Some(acc(STRANGER)), 1_000, milli(10)));
    }
    assert!(!t.is_approved(acc(STRANGER)));
    assert_eq!(t.get_policy().agent, Some(acc(AGENT)));
}

#[test]
fn owner_methods_require_exactly_one_yocto() {
    let mut t = setup();
    for deposit in [ZERO, yocto(2)] {
        ctx(OWNER, deposit, DAY);
        expect_panic("exactly 1 yoctoNEAR", || t.approve_recipient(acc(STRANGER)));
        expect_panic("exactly 1 yoctoNEAR", || t.pause());
        expect_panic("exactly 1 yoctoNEAR", || t.set_policy(milli(50), milli(100)));
        expect_panic("exactly 1 yoctoNEAR", || {
            let _ = t.withdraw(milli(1));
        });
    }
    assert!(!t.get_policy().paused);
}

#[test]
fn set_policy_updates_and_validates() {
    let mut t = setup();
    as_owner(DAY);
    t.set_policy(milli(50), milli(120));
    assert_eq!((t.get_policy().max_per_tx, t.get_policy().daily_cap), (milli(50), milli(120)));
    assert_eq!(events("policy_set").len(), 1);
    as_owner(DAY);
    expect_panic("max_per_tx must be <= daily_cap", || t.set_policy(milli(200), milli(100)));
    expect_panic("max_per_tx must be positive", || t.set_policy(ZERO, milli(100)));
}

#[test]
fn recipients_can_be_added_and_removed_with_events() {
    let mut t = setup();
    as_owner(DAY);
    t.remove_recipient(acc(SUP2));
    assert!(!t.is_approved(acc(SUP2)));
    assert_eq!(events("recipient_removed")[0]["data"][0]["account"], SUP2);
    expect_panic("Recipient not approved", || t.remove_recipient(acc(SUP2)));
    as_owner(DAY);
    t.approve_recipient(acc(SUP2));
    assert!(t.is_approved(acc(SUP2)));
    assert_eq!(events("recipient_approved").len(), 1);
}

#[test]
fn revoked_agent_cannot_request() {
    let mut t = setup();
    as_owner(DAY);
    t.set_agent(None);
    as_agent(DAY);
    expect_panic("Not the registered agent", || pay(&mut t, "run-0001:payment", SUP1, milli(10)));
}

#[test]
fn pause_blocks_requests_and_unpause_restores() {
    let mut t = setup();
    as_owner(DAY);
    t.pause();
    assert!(t.get_policy().paused);
    as_agent(DAY);
    expect_panic("Paused", || pay(&mut t, "run-0001:payment", SUP1, milli(10)));
    as_owner(DAY);
    t.unpause();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(10));
    assert_eq!(t.get_request("run-0001:payment".into()).unwrap().status, RequestStatus::Pending);
}

#[test]
fn withdraw_respects_the_storage_floor() {
    let mut t = setup();
    as_owner(DAY);
    // Available = balance − locked − (storage used + reserve) × storage cost, from the mocked account.
    let storage_cost = env::storage_byte_cost().as_yoctonear() * (u128::from(env::storage_usage()) + STORAGE_RESERVE_BYTES);
    // The balance includes the attached 1 yoctoNEAR, as on-chain.
    assert_eq!(env::account_balance(), NearToken::from_yoctonear(NearToken::from_near(10).as_yoctonear() + 1));
    let available = env::account_balance().as_yoctonear() - env::account_locked_balance().as_yoctonear() - storage_cost;
    assert_eq!(available_balance(), available);
    assert!(storage_cost > 0, "the storage requirement is kept back");
    expect_panic("Withdrawal would breach the storage reserve", || {
        let _ = t.withdraw(yocto(available + 1));
    });
    expect_panic("Withdrawal would breach the storage reserve", || {
        let _ = t.withdraw(NearToken::from_near(10));
    });
    let _ = t.withdraw(yocto(available));
    assert_eq!(events("withdrawn")[0]["data"][0]["to"], OWNER);
    as_owner(DAY);
    expect_panic("Amount must be positive", || {
        let _ = t.withdraw(ZERO);
    });
}

// =========================================================================== T-A1: every failed check reverts (no record, no spend)

#[test]
fn t_a1_every_rejected_request_leaves_no_record_and_no_spend() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "base-0001", SUP1, milli(100));
    pay(&mut t, "base-0002", SUP1, milli(100)); // 0.2 spent today
    let before = spent(&t);
    type Case = (&'static str, &'static str, &'static str, &'static str, NearToken, NearToken);
    let cases: Vec<Case> = vec![
        // (expected message, caller, request id, recipient, amount, deposit)
        ("Not the registered agent", STRANGER, "reject-0001", SUP1, milli(10), ZERO),
        ("Invalid request_id", AGENT, "short", SUP1, milli(10), ZERO),
        ("Invalid request_id", AGENT, "has spaces in it", SUP1, milli(10), ZERO),
        ("Recipient not approved", AGENT, "reject-0002", STRANGER, milli(10), ZERO),
        ("Recipient not approved", AGENT, "reject-0003", OWNER, milli(10), ZERO),
        ("Amount must be positive", AGENT, "reject-0004", SUP1, ZERO, ZERO),
        ("Amount over per-transaction limit", AGENT, "reject-0005", SUP1, milli(101), ZERO),
        ("Daily cap exceeded", AGENT, "reject-0006", SUP1, milli(51), ZERO),
        ("Duplicate request_id", AGENT, "base-0001", SUP1, milli(100), ZERO),
        ("No deposit allowed", AGENT, "reject-0007", SUP1, milli(10), yocto(1)),
    ];
    for (msg, who, id, to, amount, deposit) in cases {
        ctx(who, deposit, DAY);
        expect_panic(msg, || pay(&mut t, id, to, amount));
        if id != "base-0001" {
            assert_eq!(t.get_request(id.into()), None, "{id} must have no record");
        }
        assert_eq!(spent(&t), before, "{msg}: spend must be unchanged");
    }
    // Paused and insufficient balance, checked the same way.
    as_owner(DAY);
    t.pause();
    as_agent(DAY);
    expect_panic("Paused", || pay(&mut t, "reject-0008", SUP1, milli(10)));
    assert_eq!(t.get_request("reject-0008".into()), None);
    as_owner(DAY);
    t.unpause();
    testing_env!(context(AGENT, ZERO, DAY, milli(50)));
    expect_panic("Insufficient treasury balance", || pay(&mut t, "reject-0009", SUP1, milli(40)));
    assert_eq!(t.get_request("reject-0009".into()), None);
    assert_eq!(spent(&t), before);
}

// =========================================================================== T-A2: success path

#[test]
fn t_a2_success_marks_paid_and_keeps_the_spend() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(40));
    let r = t.get_request("run-0001:payment".into()).unwrap();
    assert_eq!(r.status, RequestStatus::Pending);
    assert_eq!(events("payout_requested").len(), 1);
    callback(DAY, true);
    assert!(t.on_payout("run-0001:payment".into()));
    let r = t.get_request("run-0001:payment".into()).unwrap();
    assert_eq!(r.status, RequestStatus::Paid);
    assert_eq!(r.settled_at_block, Some(DAY * 10));
    assert_eq!(events("payout_completed").len(), 1);
    assert_eq!(spent(&t), milli(40));
}

// =========================================================================== T-A3: failure, same day

#[test]
fn t_a3_failure_same_day_marks_failed_and_rolls_back_exactly() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(30));
    pay(&mut t, "run-0002:payment", SUP2, milli(40));
    assert_eq!(spent(&t), milli(70));
    callback(DAY, false);
    assert!(!t.on_payout("run-0002:payment".into()));
    assert_eq!(t.get_request("run-0002:payment".into()).unwrap().status, RequestStatus::Failed);
    let e = &events("payout_failed")[0]["data"][0];
    assert_eq!(e["rolled_back"], true);
    assert_eq!(spent(&t), milli(30));
}

// =========================================================================== T-A4: failure across UTC midnight

#[test]
fn t_a4_failure_after_midnight_does_not_touch_the_new_days_total() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "day-d-0001", SUP1, milli(100));
    // A new UTC day starts and another request moves the counter to D+1.
    as_agent(DAY + 1);
    pay(&mut t, "day-d1-0001", SUP2, milli(50));
    assert_eq!(t.get_spent_today().day, DAY + 1);
    assert_eq!(spent(&t), milli(50));
    // The day-D transfer fails, settled on D+1.
    callback(DAY + 1, false);
    assert!(!t.on_payout("day-d-0001".into()));
    assert_eq!(t.get_request("day-d-0001".into()).unwrap().status, RequestStatus::Failed);
    assert_eq!(events("payout_failed")[0]["data"][0]["rolled_back"], false);
    assert_eq!(spent(&t), milli(50), "D+1 total must be unchanged");
}

// =========================================================================== T-A5: callback on D+1 before any D+1 request

#[test]
fn t_a5_failure_settled_next_day_before_any_new_request_rolls_back_day_d() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "day-d-0001", SUP1, milli(100));
    callback(DAY + 1, false); // counter is still on day D
    assert!(!t.on_payout("day-d-0001".into()));
    assert_eq!(events("payout_failed")[0]["data"][0]["rolled_back"], true);
    // View on D+1 shows 0 (a new day); the next request starts D+1's total from its own amount.
    assert_eq!(spent(&t), ZERO);
    as_agent(DAY + 1);
    pay(&mut t, "day-d1-0001", SUP2, milli(100));
    pay(&mut t, "day-d1-0002", SUP2, milli(100));
    assert_eq!(spent(&t), milli(200));
}

// =========================================================================== T-A6: duplicates

#[test]
fn t_a6_pending_and_paid_requests_can_never_be_requested_again() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(10));
    expect_panic("Duplicate request_id", || pay(&mut t, "run-0001:payment", SUP1, milli(10)));
    callback(DAY, true);
    t.on_payout("run-0001:payment".into());
    as_agent(DAY);
    expect_panic("Duplicate request_id", || pay(&mut t, "run-0001:payment", SUP1, milli(10)));
    expect_panic("Duplicate request_id", || pay(&mut t, "run-0001:payment", SUP2, milli(20)));
    assert_eq!(t.get_request("run-0001:payment".into()).unwrap().attempts, 1);
}

// =========================================================================== T-A7: retry rules

#[test]
fn t_a7_retry_only_after_failure_with_identical_details_and_never_twice_paid() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(40));
    callback(DAY, false);
    t.on_payout("run-0001:payment".into());
    as_agent(DAY);
    expect_panic("Retry must match the failed request", || pay(&mut t, "run-0001:payment", SUP2, milli(40)));
    expect_panic("Retry must match the failed request", || pay(&mut t, "run-0001:payment", SUP1, milli(41)));
    pay(&mut t, "run-0001:payment", SUP1, milli(40));
    let r = t.get_request("run-0001:payment".into()).unwrap();
    assert_eq!((r.status, r.attempts, r.settled_at_block), (RequestStatus::Pending, 2, None));
    assert_eq!(spent(&t), milli(40));
    callback(DAY, true);
    assert!(t.on_payout("run-0001:payment".into()));
    assert_eq!(t.get_request("run-0001:payment".into()).unwrap().status, RequestStatus::Paid);
    as_agent(DAY);
    expect_panic("Duplicate request_id", || pay(&mut t, "run-0001:payment", SUP1, milli(40)));
}

#[test]
fn retry_counts_against_the_current_days_cap() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(100));
    callback(DAY, false);
    t.on_payout("run-0001:payment".into());
    as_agent(DAY + 1);
    pay(&mut t, "other-0001", SUP2, milli(100));
    pay(&mut t, "other-0002", SUP2, milli(100));
    expect_panic("Daily cap exceeded", || pay(&mut t, "run-0001:payment", SUP1, milli(100)));
    assert_eq!(t.get_request("run-0001:payment".into()).unwrap().status, RequestStatus::Failed);
}

#[test]
fn retry_is_refused_once_the_recipient_is_no_longer_approved() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(10));
    callback(DAY, false);
    t.on_payout("run-0001:payment".into());
    as_owner(DAY);
    t.remove_recipient(acc(SUP1));
    as_agent(DAY);
    expect_panic("Recipient not approved", || pay(&mut t, "run-0001:payment", SUP1, milli(10)));
}

// =========================================================================== T-A8: callbacks are private

#[test]
fn t_a8_callbacks_reject_external_callers() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(10));
    for who in [AGENT, OWNER, STRANGER] {
        with_promise_result(context(who, ZERO, DAY, NearToken::from_near(10)), PromiseResult::Failed);
        expect_panic("Only the contract itself", || {
            t.on_payout("run-0001:payment".into());
        });
        expect_panic("Only the contract itself", || {
            t.on_contributors_share("order-1".into(), milli(1));
        });
    }
    assert_eq!(t.get_request("run-0001:payment".into()).unwrap().status, RequestStatus::Pending);
    assert_eq!(spent(&t), milli(10));
}

// =========================================================================== T-A9: no double settlement

#[test]
fn t_a9_unknown_or_already_settled_requests_cannot_be_settled() {
    let mut t = setup();
    callback(DAY, true);
    expect_panic("Unknown request_id", || {
        t.on_payout("never-recorded".into());
    });
    as_agent(DAY);
    pay(&mut t, "paid-0001", SUP1, milli(10));
    pay(&mut t, "fail-0001", SUP2, milli(10));
    callback(DAY, true);
    t.on_payout("paid-0001".into());
    callback(DAY, false);
    t.on_payout("fail-0001".into());
    let spent_after = spent(&t);
    for (id, ok) in [("paid-0001", false), ("paid-0001", true), ("fail-0001", false), ("fail-0001", true)] {
        callback(DAY, ok);
        expect_panic("Request already settled", || {
            t.on_payout(id.into());
        });
    }
    assert_eq!(t.get_request("paid-0001".into()).unwrap().status, RequestStatus::Paid);
    assert_eq!(t.get_request("fail-0001".into()).unwrap().status, RequestStatus::Failed);
    assert_eq!(spent(&t), spent_after, "a second failure must not roll back twice");
}

#[test]
fn callback_requires_exactly_one_promise_result() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(10));
    ctx(TREASURY, ZERO, DAY); // no promise results
    expect_panic("Expected one promise result", || {
        t.on_payout("run-0001:payment".into());
    });
}

// =========================================================================== T-A10: cap accounting with pending requests

#[test]
fn t_a10_pending_requests_count_and_a_same_day_failure_frees_its_amount() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "cap-0001", SUP1, milli(100));
    pay(&mut t, "cap-0002", SUP1, milli(100));
    expect_panic("Daily cap exceeded", || pay(&mut t, "cap-0003", SUP1, milli(100)));
    callback(DAY, false);
    t.on_payout("cap-0002".into());
    as_agent(DAY);
    pay(&mut t, "cap-0003", SUP1, milli(100));
    assert_eq!(spent(&t), milli(200));
    // Exactly at the cap is allowed; one yocto over is not.
    pay(&mut t, "cap-0004", SUP2, milli(50));
    assert_eq!(spent(&t), milli(250));
    expect_panic("Daily cap exceeded", || pay(&mut t, "cap-0005", SUP2, yocto(1)));
}

// =========================================================================== T-A11: promise-result reading

#[test]
fn t_a11_on_payout_reads_the_mocked_promise_result() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "ok-00001", SUP1, milli(10));
    pay(&mut t, "fail-0001", SUP1, milli(10));
    pay(&mut t, "long-0001", SUP1, milli(10));
    callback(DAY, true);
    assert!(t.on_payout("ok-00001".into()));
    callback(DAY, false);
    assert!(!t.on_payout("fail-0001".into()));
    // A successful promise with an unexpectedly long value is still a success: it must never be
    // treated as a failure, which would allow a retry of a payout that happened.
    with_promise_result(context(TREASURY, ZERO, DAY, NearToken::from_near(10)), PromiseResult::Successful(vec![7u8; 1_000]));
    assert!(t.on_payout("long-0001".into()));
    assert_eq!(t.get_request("long-0001".into()).unwrap().status, RequestStatus::Paid);
}

// =========================================================================== T-A12: event schema

#[test]
fn t_a12_payout_event_payloads_match_the_schema_exactly() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(40));
    let req = events("payout_requested").remove(0);
    assert_eq!(
        req,
        json!({ "standard": "employai-treasury", "version": "1.0.0", "event": "payout_requested",
                "data": [{ "request_id": "run-0001:payment", "recipient": SUP1, "amount": milli(40), "agent": AGENT, "day": DAY, "attempt": 1 }] })
    );
    callback(DAY, false);
    t.on_payout("run-0001:payment".into());
    assert_eq!(
        events("payout_failed").remove(0),
        json!({ "standard": "employai-treasury", "version": "1.0.0", "event": "payout_failed",
                "data": [{ "request_id": "run-0001:payment", "recipient": SUP1, "amount": milli(40), "agent": AGENT, "day": DAY, "rolled_back": true }] })
    );
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(40));
    callback(DAY, true);
    t.on_payout("run-0001:payment".into());
    assert_eq!(
        events("payout_completed").remove(0),
        json!({ "standard": "employai-treasury", "version": "1.0.0", "event": "payout_completed",
                "data": [{ "request_id": "run-0001:payment", "recipient": SUP1, "amount": milli(40), "agent": AGENT, "day": DAY }] })
    );
}

// =========================================================================== T-A13: durable records

#[test]
fn t_a13_records_are_durable_and_complete() {
    let mut t = setup();
    assert_eq!(t.get_request("never-recorded".into()), None);
    as_agent(DAY);
    pay(&mut t, "paid-0001", SUP1, milli(10));
    pay(&mut t, "fail-0001", SUP2, milli(20));
    callback(DAY + 1, true);
    t.on_payout("paid-0001".into());
    callback(DAY + 1, false);
    t.on_payout("fail-0001".into());
    // Days pass and other activity happens; the records stay exactly as settled.
    as_agent(DAY + 5);
    pay(&mut t, "later-0001", SUP1, milli(10));
    assert_eq!(
        t.get_request("paid-0001".into()).unwrap(),
        PaymentRequest {
            recipient: acc(SUP1),
            amount: milli(10),
            day: DAY,
            status: RequestStatus::Paid,
            agent: acc(AGENT),
            requested_at_block: DAY * 10,
            settled_at_block: Some((DAY + 1) * 10),
            attempts: 1,
        }
    );
    let f = t.get_request("fail-0001".into()).unwrap();
    assert_eq!((f.status, f.amount, f.recipient, f.day, f.settled_at_block), (RequestStatus::Failed, milli(20), acc(SUP2), DAY, Some((DAY + 1) * 10)));
    // A request whose call panicked is never recorded.
    expect_panic("Recipient not approved", || pay(&mut t, "panicked-01", STRANGER, milli(10)));
    assert_eq!(t.get_request("panicked-01".into()), None);
}

// =========================================================================== request IDs, views, agent and recipient changes

#[test]
fn request_id_bounds_and_charset() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "12345678", SUP1, yocto(1)); // exactly 8
    pay(&mut t, &"a".repeat(64), SUP1, yocto(1)); // exactly 64
    pay(&mut t, "Run_1-2:payment", SUP1, yocto(1));
    for bad in ["1234567", &"a".repeat(65), "run/0001", "run.0001x", "rün-0001", ""] {
        expect_panic("Invalid request_id", || pay(&mut t, bad, SUP1, yocto(1)));
    }
}

#[test]
fn spent_view_resets_on_a_new_day() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(100));
    assert_eq!(t.get_spent_today(), SpentView { day: DAY, spent: milli(100), daily_cap: milli(250) });
    ctx(STRANGER, ZERO, DAY + 1);
    assert_eq!(t.get_spent_today(), SpentView { day: DAY + 1, spent: ZERO, daily_cap: milli(250) });
}

#[test]
fn a_pending_request_settles_even_after_the_agent_is_revoked_or_recipient_removed() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(10));
    as_owner(DAY);
    t.set_agent(None);
    t.remove_recipient(acc(SUP1));
    callback(DAY, true);
    assert!(t.on_payout("run-0001:payment".into()));
    assert_eq!(t.get_request("run-0001:payment".into()).unwrap().status, RequestStatus::Paid);
}

#[test]
fn caps_follow_a_policy_change() {
    let mut t = setup();
    as_owner(DAY);
    t.set_policy(milli(20), milli(30));
    as_agent(DAY);
    expect_panic("Amount over per-transaction limit", || pay(&mut t, "run-0001:payment", SUP1, milli(21)));
    pay(&mut t, "run-0002:payment", SUP1, milli(20));
    expect_panic("Daily cap exceeded", || pay(&mut t, "run-0003:payment", SUP1, milli(11)));
}

// =========================================================================== customer sales (disabled in M5)

#[test]
fn pay_order_is_rejected_while_sales_are_disabled() {
    let mut t = setup();
    ctx("customer.testnet", NearToken::from_near(1), DAY);
    expect_panic("Sales disabled", || {
        let _ = t.pay_order("order-1".into());
    });
    // "Sales disabled" is checked before everything else, including pause.
    as_owner(DAY);
    t.pause();
    ctx("customer.testnet", NearToken::from_near(1), DAY);
    expect_panic("Sales disabled", || {
        let _ = t.pay_order("order-1".into());
    });
}

#[test]
fn set_sales_validates_and_is_owner_only() {
    let mut t = setup();
    as_owner(DAY);
    expect_panic("Contributors account required", || t.set_sales(true, None, 1_000, milli(10)));
    expect_panic("split_bps must be <= 10000", || t.set_sales(true, Some(acc("contributors.testnet")), 10_001, milli(10)));
    expect_panic("min_order must be positive", || t.set_sales(true, Some(acc("contributors.testnet")), 1_000, ZERO));
    assert!(!t.get_policy().sales_enabled);
}

#[test]
fn pay_order_when_enabled_checks_pause_and_minimum_and_reports_the_share_outcome() {
    let mut t = setup();
    as_owner(DAY);
    t.set_sales(true, Some(acc("contributors.testnet")), 1_000, milli(500));
    assert!(t.get_policy().sales_enabled);
    ctx("customer.testnet", milli(100), DAY);
    expect_panic("Below minimum order value", || {
        let _ = t.pay_order("order-1".into());
    });
    as_owner(DAY);
    t.pause();
    ctx("customer.testnet", NearToken::from_near(1), DAY);
    expect_panic("Paused", || {
        let _ = t.pay_order("order-1".into());
    });
    as_owner(DAY);
    t.unpause();
    ctx("customer.testnet", NearToken::from_near(1), DAY);
    let _ = t.pay_order("order-1".into());
    let sale = &events("sale_received")[0]["data"][0];
    assert_eq!(sale["contributors_share"], json!(milli(100)));
    with_promise_result(context(TREASURY, ZERO, DAY, NearToken::from_near(10)), PromiseResult::Failed);
    assert!(!t.on_contributors_share("order-1".into(), milli(100)));
    assert_eq!(events("contributors_share_failed").len(), 1);
}

#[test]
fn constants_match_the_plan() {
    assert_eq!(CALLBACK_GAS, Gas::from_tgas(10));
    assert_eq!((REQUEST_ID_MIN, REQUEST_ID_MAX), (8, 64));
    assert_eq!((EVENT_STANDARD, EVENT_VERSION), ("employai-treasury", "1.0.0"));
}

// =========================================================================== receipts the contract creates

fn receipts() -> Vec<near_sdk::mock::Receipt> {
    near_sdk::mock::with_mocked_blockchain(|b| b.created_receipts())
}

#[test]
fn request_payment_creates_a_transfer_then_a_private_callback_with_10_tgas() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(40));
    let r = receipts();
    assert_eq!(r.len(), 2, "one transfer receipt and one callback receipt");
    assert_eq!(r[0].receiver_id, acc(SUP1));
    assert!(matches!(r[0].actions.as_slice(), [near_sdk::mock::MockAction::Transfer { deposit, .. }] if *deposit == milli(40)));
    assert_eq!(r[1].receiver_id, acc(TREASURY));
    assert_eq!(r[1].receipt_indices, vec![0], "the callback waits for the transfer");
    match r[1].actions.as_slice() {
        [near_sdk::mock::MockAction::FunctionCallWeight { method_name, attached_deposit, prepaid_gas, .. }] => {
            assert_eq!(method_name.as_slice(), b"on_payout");
            assert_eq!(*attached_deposit, ZERO);
            assert_eq!(*prepaid_gas, CALLBACK_GAS);
        }
        other => panic!("unexpected callback actions {other:?}"),
    }
}

#[test]
fn rejected_requests_create_no_receipts() {
    let mut t = setup();
    as_agent(DAY);
    expect_panic("Recipient not approved", || pay(&mut t, "run-0001:payment", STRANGER, milli(10)));
    assert!(receipts().is_empty());
}

#[test]
fn withdraw_transfers_only_to_the_owner() {
    let mut t = setup();
    as_owner(DAY);
    let _ = t.withdraw(milli(500));
    let r = receipts();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].receiver_id, acc(OWNER));
    assert!(matches!(r[0].actions.as_slice(), [near_sdk::mock::MockAction::Transfer { deposit, .. }] if *deposit == milli(500)));
}

#[test]
fn pay_order_creates_no_receipts_while_sales_are_disabled() {
    let mut t = setup();
    ctx("customer.testnet", NearToken::from_near(1), DAY);
    expect_panic("Sales disabled", || {
        let _ = t.pay_order("order-1".into());
    });
    assert!(receipts().is_empty());
}

// =========================================================================== events and remaining edge cases

#[test]
fn init_emits_an_initialised_event_with_sales_disabled() {
    ctx(TREASURY, ZERO, DAY);
    let _t = Treasury::new(acc(OWNER), Some(acc(AGENT)), milli(100), milli(250));
    let e = &events("initialised")[0]["data"][0];
    assert_eq!((e["owner"].as_str(), e["agent"].as_str(), e["sales_enabled"].as_bool()), (Some(OWNER), Some(AGENT), Some(false)));
}

#[test]
fn pause_and_unpause_emit_events() {
    let mut t = setup();
    as_owner(DAY);
    t.pause();
    t.unpause();
    assert_eq!((events("paused").len(), events("unpaused").len()), (1, 1));
    assert!(!t.get_policy().paused);
}

#[test]
fn a_new_agent_replaces_the_old_one() {
    let mut t = setup();
    as_owner(DAY);
    t.set_agent(Some(acc("finance-agent-2.employai-demo.testnet")));
    assert_eq!(events("agent_set")[0]["data"][0]["agent"], "finance-agent-2.employai-demo.testnet");
    as_agent(DAY);
    expect_panic("Not the registered agent", || pay(&mut t, "run-0001:payment", SUP1, milli(10)));
    ctx("finance-agent-2.employai-demo.testnet", ZERO, DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(10));
    assert_eq!(t.get_request("run-0001:payment".into()).unwrap().agent, acc("finance-agent-2.employai-demo.testnet"));
}

#[test]
fn exactly_the_per_payment_maximum_is_allowed() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(100));
    expect_panic("Amount over per-transaction limit", || pay(&mut t, "run-0002:payment", SUP1, NearToken::from_yoctonear(milli(100).as_yoctonear() + 1)));
}

#[test]
fn a_retry_records_its_new_day_and_block_and_clears_settlement() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(40));
    callback(DAY, false);
    t.on_payout("run-0001:payment".into());
    as_agent(DAY + 2);
    pay(&mut t, "run-0001:payment", SUP1, milli(40));
    let r = t.get_request("run-0001:payment".into()).unwrap();
    assert_eq!((r.day, r.requested_at_block, r.settled_at_block, r.attempts), (DAY + 2, (DAY + 2) * 10, None, 2));
    assert_eq!(events("payout_requested")[0]["data"][0]["attempt"], 2);
}

#[test]
fn a_short_non_empty_promise_value_is_a_success() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(10));
    with_promise_result(context(TREASURY, ZERO, DAY, NearToken::from_near(10)), PromiseResult::Successful(b"true".to_vec()));
    assert!(t.on_payout("run-0001:payment".into()));
}

#[test]
fn requests_for_different_ids_are_independent() {
    let mut t = setup();
    as_agent(DAY);
    pay(&mut t, "run-0001:payment", SUP1, milli(10));
    pay(&mut t, "run-0002:payment", SUP2, milli(20));
    callback(DAY, false);
    t.on_payout("run-0001:payment".into());
    assert_eq!(t.get_request("run-0002:payment".into()).unwrap().status, RequestStatus::Pending);
    assert_eq!(spent(&t), milli(20));
}

#[test]
fn pay_order_share_is_exact_and_rounds_down() {
    let mut t = setup();
    as_owner(DAY);
    t.set_sales(true, Some(acc("contributors.testnet")), 1_234, milli(1));
    ctx("customer.testnet", yocto(1_000_000_000_000_000_000_007), DAY);
    let _ = t.pay_order("order-1".into());
    // floor(1_000_000_000_000_000_000_007 × 1234 / 10000) = 123_400_000_000_000_000_000 (the 7 × 1234 / 10000 part rounds to 0)
    assert_eq!(events("sale_received")[0]["data"][0]["contributors_share"], json!(yocto(123_400_000_000_000_000_000)));
}

#[test]
fn pay_order_with_a_zero_split_makes_no_transfer() {
    let mut t = setup();
    as_owner(DAY);
    t.set_sales(true, Some(acc("contributors.testnet")), 0, milli(1));
    ctx("customer.testnet", milli(10), DAY);
    assert!(matches!(t.pay_order("order-1".into()), PromiseOrValue::Value(true)));
    assert!(receipts().is_empty());
}

#[test]
fn pay_order_rejects_bad_order_ids() {
    let mut t = setup();
    as_owner(DAY);
    t.set_sales(true, Some(acc("contributors.testnet")), 1_000, milli(1));
    ctx("customer.testnet", milli(10), DAY);
    expect_panic("Invalid order_id", || {
        let _ = t.pay_order(String::new());
    });
    expect_panic("Invalid order_id", || {
        let _ = t.pay_order("x".repeat(65));
    });
}

#[test]
fn contributors_share_success_is_reported() {
    let mut t = setup();
    with_promise_result(context(TREASURY, ZERO, DAY, NearToken::from_near(10)), PromiseResult::Successful(vec![]));
    assert!(t.on_contributors_share("order-1".into(), milli(100)));
    assert_eq!(events("contributors_share_completed").len(), 1);
}

#[test]
fn sales_can_be_disabled_again() {
    let mut t = setup();
    as_owner(DAY);
    t.set_sales(true, Some(acc("contributors.testnet")), 1_000, milli(1));
    t.set_sales(false, None, 0, ZERO);
    assert!(!t.get_policy().sales_enabled);
    assert_eq!(events("sales_config_set").len(), 2);
    ctx("customer.testnet", milli(10), DAY);
    expect_panic("Sales disabled", || {
        let _ = t.pay_order("order-1".into());
    });
}
