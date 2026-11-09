//! EmployAI treasury contract v1 (M5 plan v3.1, §6).
//!
//! Agents can only *request* supplier payouts; this contract decides whether they happen. Every money
//! rule is enforced here, independently of the application: the registered agent only, an on-chain
//! recipient allowlist, per-payment and daily caps, pause, and at most one successful payout per
//! request ID.
//!
//! Asynchronous model (plan §6.5). `request_payment` runs in one receipt: all checks, then the request is
//! recorded `Pending`, the day's total is increased, and a transfer with an `on_payout` callback is
//! created. The transfer runs in a later receipt; on failure the protocol refunds the amount in its own
//! receipt (ordering relative to the callback is not guaranteed, so nothing here reads the balance in
//! the callback). `on_payout` reads the promise result and calls `settle`, which marks the request
//! `Paid` or `Failed`, and on failure rolls back the daily total only if the counter is still on the
//! request's own day. A panic anywhere in `request_payment` reverts everything, so a rejected request
//! leaves no record.
//!
//! Request records are never deleted: `get_request` is the durable source of payment status.
//! Customer sales (`pay_order`) are present but disabled until the owner enables them (M6).
use near_sdk::serde_json::{Value, json};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, env, near,
    require,
};

#[cfg(test)]
mod tests;

const DAY_NS: u64 = 86_400_000_000_000;
/// Gas reserved for each callback (`on_payout`, `on_contributors_share`). To be confirmed with measured
/// usage on testnet (plan R-A7: at least 3x the measured use).
pub const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// A transfer's success value is empty; anything longer is still a success (see `on_payout`).
const MAX_CALLBACK_RESULT_LEN: usize = 64;
/// Storage kept back when checking whether a payout or withdrawal is affordable (one request record
/// plus margin), so the contract never drops below its storage requirement.
const STORAGE_RESERVE_BYTES: u128 = 1_000;
const REQUEST_ID_MIN: usize = 8;
const REQUEST_ID_MAX: usize = 64;
const ORDER_ID_MAX: usize = 64;
const EVENT_STANDARD: &str = "employai-treasury";
const EVENT_VERSION: &str = "1.0.0";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Approved,
    Requests,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestStatus {
    Pending,
    Paid,
    Failed,
}

/// One payout request. Never deleted.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentRequest {
    pub recipient: AccountId,
    pub amount: NearToken,
    /// UTC day (block time / 86,400 s) whose total this request counts against.
    pub day: u64,
    pub status: RequestStatus,
    pub agent: AccountId,
    pub requested_at_block: u64,
    pub settled_at_block: Option<u64>,
    /// 1 for the first request; +1 for each retry after a failed transfer.
    pub attempts: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SalesConfig {
    pub enabled: bool,
    pub contributors: Option<AccountId>,
    pub split_bps: u16,
    pub min_order: NearToken,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyView {
    pub owner: AccountId,
    pub agent: Option<AccountId>,
    pub max_per_tx: NearToken,
    pub daily_cap: NearToken,
    pub paused: bool,
    pub sales_enabled: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpentView {
    pub day: u64,
    pub spent: NearToken,
    pub daily_cap: NearToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Treasury {
    owner: AccountId,
    agent: Option<AccountId>,
    max_per_tx: NearToken,
    daily_cap: NearToken,
    /// The day `spent_today` belongs to. Moves forward only when a new request is made.
    day: u64,
    spent_today: NearToken,
    paused: bool,
    approved: LookupSet<AccountId>,
    requests: LookupMap<String, PaymentRequest>,
    sales: SalesConfig,
}

const ZERO: NearToken = NearToken::from_yoctonear(0);

fn event(kind: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": kind, "data": [data] })
    ));
}

fn current_day() -> u64 {
    env::block_timestamp() / DAY_NS
}

fn valid_request_id(id: &str) -> bool {
    (REQUEST_ID_MIN..=REQUEST_ID_MAX).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'_' || b == b'-')
}

/// The callback and init are `#[private]` (checked by the generated entry point). This repeats the
/// check inside the method so it holds for every caller and is provable in unit tests.
fn require_self_call() {
    require!(env::predecessor_account_id() == env::current_account_id(), "Only the contract itself");
}

/// Balance that can leave the contract without breaking its storage requirement.
fn available_balance() -> u128 {
    let storage = env::storage_byte_cost().as_yoctonear() * (u128::from(env::storage_usage()) + STORAGE_RESERVE_BYTES);
    env::account_balance()
        .as_yoctonear()
        .saturating_sub(env::account_locked_balance().as_yoctonear())
        .saturating_sub(storage)
}

#[near]
impl Treasury {
    /// Initialise once. `#[private]`: only the contract account itself can call it, and the deployment
    /// must call it in the same transaction as the deploy (plan C8).
    #[init]
    #[private]
    pub fn new(owner: AccountId, agent: Option<AccountId>, max_per_tx: NearToken, daily_cap: NearToken) -> Self {
        require_self_call();
        require!(max_per_tx.as_yoctonear() > 0, "max_per_tx must be positive");
        require!(max_per_tx <= daily_cap, "max_per_tx must be <= daily_cap");
        let day = current_day();
        event(
            "initialised",
            json!({ "owner": owner, "agent": agent, "max_per_tx": max_per_tx, "daily_cap": daily_cap, "sales_enabled": false }),
        );
        Self {
            owner,
            agent,
            max_per_tx,
            daily_cap,
            day,
            spent_today: ZERO,
            paused: false,
            approved: LookupSet::new(StorageKey::Approved),
            requests: LookupMap::new(StorageKey::Requests),
            sales: SalesConfig { enabled: false, contributors: None, split_bps: 0, min_order: ZERO },
        }
    }

    // ------------------------------------------------------------------ owner methods (1 yoctoNEAR each)

    #[payable]
    pub fn set_agent(&mut self, agent: Option<AccountId>) {
        self.assert_owner_one_yocto();
        self.agent = agent.clone();
        event("agent_set", json!({ "agent": agent }));
    }

    #[payable]
    pub fn set_policy(&mut self, max_per_tx: NearToken, daily_cap: NearToken) {
        self.assert_owner_one_yocto();
        require!(max_per_tx.as_yoctonear() > 0, "max_per_tx must be positive");
        require!(max_per_tx <= daily_cap, "max_per_tx must be <= daily_cap");
        self.max_per_tx = max_per_tx;
        self.daily_cap = daily_cap;
        event("policy_set", json!({ "max_per_tx": max_per_tx, "daily_cap": daily_cap }));
    }

    #[payable]
    pub fn approve_recipient(&mut self, account: AccountId) {
        self.assert_owner_one_yocto();
        self.approved.insert(account.clone());
        event("recipient_approved", json!({ "account": account }));
    }

    #[payable]
    pub fn remove_recipient(&mut self, account: AccountId) {
        self.assert_owner_one_yocto();
        require!(self.approved.remove(&account), "Recipient not approved");
        event("recipient_removed", json!({ "account": account }));
    }

    #[payable]
    pub fn pause(&mut self) {
        self.assert_owner_one_yocto();
        self.paused = true;
        event("paused", json!({ "by": env::predecessor_account_id() }));
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner_one_yocto();
        self.paused = false;
        event("unpaused", json!({ "by": env::predecessor_account_id() }));
    }

    /// Withdraw to the owner, never below the storage requirement plus reserve.
    #[payable]
    pub fn withdraw(&mut self, amount: NearToken) -> Promise {
        self.assert_owner_one_yocto();
        require!(amount.as_yoctonear() > 0, "Amount must be positive");
        require!(amount.as_yoctonear() <= available_balance(), "Withdrawal would breach the storage reserve");
        event("withdrawn", json!({ "amount": amount, "to": self.owner }));
        Promise::new(self.owner.clone()).transfer(amount)
    }

    /// Configure customer sales. Disabled at initialisation and not used by the application in M5.
    #[payable]
    pub fn set_sales(&mut self, enabled: bool, contributors: Option<AccountId>, split_bps: u16, min_order: NearToken) {
        self.assert_owner_one_yocto();
        require!(split_bps <= 10_000, "split_bps must be <= 10000");
        if enabled {
            require!(contributors.is_some(), "Contributors account required to enable sales");
            require!(min_order.as_yoctonear() > 0, "min_order must be positive to enable sales");
        }
        self.sales = SalesConfig { enabled, contributors: contributors.clone(), split_bps, min_order };
        event(
            "sales_config_set",
            json!({ "enabled": enabled, "contributors": contributors, "split_bps": split_bps, "min_order": min_order }),
        );
    }

    // ------------------------------------------------------------------ agent payout

    /// Request a payout. Called by the registered agent with a function-call key limited to this method.
    /// Every check runs before any state changes. A request ID can succeed at most once: Pending or Paid
    /// can never be requested again; Failed can be retried only with the same recipient and amount.
    pub fn request_payment(&mut self, request_id: String, recipient: AccountId, amount: NearToken) -> Promise {
        require!(env::attached_deposit().as_yoctonear() == 0, "No deposit allowed");
        require!(!self.paused, "Paused");
        let agent = env::predecessor_account_id();
        require!(self.agent.as_ref() == Some(&agent), "Not the registered agent");
        require!(valid_request_id(&request_id), "Invalid request_id");
        require!(self.approved.contains(&recipient), "Recipient not approved");
        require!(amount.as_yoctonear() > 0, "Amount must be positive");
        require!(amount <= self.max_per_tx, "Amount over per-transaction limit");
        let attempts = match self.requests.get(&request_id) {
            None => 1,
            Some(previous) if previous.status == RequestStatus::Failed => {
                require!(
                    previous.recipient == recipient && previous.amount == amount,
                    "Retry must match the failed request"
                );
                previous.attempts + 1
            }
            Some(_) => env::panic_str("Duplicate request_id"),
        };
        let today = current_day();
        let spent = if today == self.day { self.spent_today } else { ZERO };
        let new_total = spent.checked_add(amount).unwrap_or_else(|| env::panic_str("Overflow"));
        require!(new_total <= self.daily_cap, "Daily cap exceeded");
        require!(amount.as_yoctonear() <= available_balance(), "Insufficient treasury balance");

        // All checks passed: record, count, then transfer with a callback.
        self.day = today;
        self.spent_today = new_total;
        self.requests.insert(
            request_id.clone(),
            PaymentRequest {
                recipient: recipient.clone(),
                amount,
                day: today,
                status: RequestStatus::Pending,
                agent: agent.clone(),
                requested_at_block: env::block_height(),
                settled_at_block: None,
                attempts,
            },
        );
        event(
            "payout_requested",
            json!({ "request_id": request_id, "recipient": recipient, "amount": amount, "agent": agent, "day": today, "attempt": attempts }),
        );
        Promise::new(recipient)
            .transfer(amount)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_payout(request_id))
    }

    /// Callback after the transfer. Returns `true` if the supplier was paid, `false` if the transfer
    /// failed (the transaction itself still succeeds; callers must read this value or the events).
    #[private]
    pub fn on_payout(&mut self, request_id: String) -> bool {
        require_self_call();
        require!(env::promise_results_count() == 1, "Expected one promise result");
        let transferred = match env::promise_result_checked(0, MAX_CALLBACK_RESULT_LEN) {
            Ok(_) => true,
            // The promise succeeded; only its return value was longer than expected. Treating this as a
            // failure would allow a retry of a payout that happened.
            Err(PromiseError::TooLong(_)) => true,
            Err(PromiseError::Failed) => false,
            // `PromiseError` is non-exhaustive. An unrecognised result is neither proof of payment nor of
            // failure, so refuse to settle: the request stays Pending (never paid twice, never retried)
            // and the app reports it as unknown.
            Err(_) => env::panic_str("Unrecognised promise result"),
        };
        self.settle(&request_id, transferred)
    }

    // ------------------------------------------------------------------ customer sales (disabled in M5)

    /// Customer payment with revenue split. Rejected while sales are disabled (the default).
    #[payable]
    pub fn pay_order(&mut self, order_id: String) -> PromiseOrValue<bool> {
        require!(self.sales.enabled, "Sales disabled");
        require!(!self.paused, "Paused");
        require!(!order_id.is_empty() && order_id.len() <= ORDER_ID_MAX, "Invalid order_id");
        let deposit = env::attached_deposit();
        require!(deposit >= self.sales.min_order, "Below minimum order value");
        let contributors = self.sales.contributors.clone().unwrap_or_else(|| env::panic_str("Sales misconfigured"));
        let share = NearToken::from_yoctonear(deposit.as_yoctonear() / 10_000 * u128::from(self.sales.split_bps)
            + deposit.as_yoctonear() % 10_000 * u128::from(self.sales.split_bps) / 10_000);
        event(
            "sale_received",
            json!({ "order_id": order_id, "payer": env::predecessor_account_id(), "amount": deposit, "contributors_share": share }),
        );
        if share.as_yoctonear() == 0 {
            return PromiseOrValue::Value(true);
        }
        Promise::new(contributors)
            .transfer(share)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_contributors_share(order_id, share))
            .into()
    }

    #[private]
    pub fn on_contributors_share(&mut self, order_id: String, share: NearToken) -> bool {
        require_self_call();
        require!(env::promise_results_count() == 1, "Expected one promise result");
        let ok = !matches!(env::promise_result_checked(0, MAX_CALLBACK_RESULT_LEN), Err(PromiseError::Failed));
        event(
            if ok { "contributors_share_completed" } else { "contributors_share_failed" },
            json!({ "order_id": order_id, "contributors_share": share }),
        );
        ok
    }

    // ------------------------------------------------------------------ views

    pub fn get_policy(&self) -> PolicyView {
        PolicyView {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            max_per_tx: self.max_per_tx,
            daily_cap: self.daily_cap,
            paused: self.paused,
            sales_enabled: self.sales.enabled,
        }
    }

    /// `null` if the request ID has never been recorded; otherwise the full, durable record.
    pub fn get_request(&self, request_id: String) -> Option<PaymentRequest> {
        self.requests.get(&request_id).cloned()
    }

    pub fn is_approved(&self, account: AccountId) -> bool {
        self.approved.contains(&account)
    }

    /// The current UTC day's total (zero if no request has been made today yet).
    pub fn get_spent_today(&self) -> SpentView {
        let today = current_day();
        SpentView { day: today, spent: if today == self.day { self.spent_today } else { ZERO }, daily_cap: self.daily_cap }
    }

    pub fn get_sales_config(&self) -> SalesConfig {
        self.sales.clone()
    }
}

impl Treasury {
    fn assert_owner_one_yocto(&self) {
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        near_sdk::assert_one_yocto();
    }

    /// Settle a Pending request exactly once. Not callable from outside the contract (no `#[near]`
    /// export); reached only through the private `on_payout` callback.
    fn settle(&mut self, request_id: &str, transferred: bool) -> bool {
        let mut request = self.requests.get(request_id).cloned().unwrap_or_else(|| env::panic_str("Unknown request_id"));
        require!(request.status == RequestStatus::Pending, "Request already settled");
        request.settled_at_block = Some(env::block_height());
        if transferred {
            request.status = RequestStatus::Paid;
            event(
                "payout_completed",
                json!({ "request_id": request_id, "recipient": request.recipient, "amount": request.amount, "agent": request.agent, "day": request.day }),
            );
        } else {
            request.status = RequestStatus::Failed;
            // Roll back only if the counter is still on the request's own day; once a new day has started,
            // the old day's total no longer affects any limit and the new day's total must not change.
            let rolled_back = self.day == request.day;
            if rolled_back {
                self.spent_today = self.spent_today.saturating_sub(request.amount);
            }
            event(
                "payout_failed",
                json!({ "request_id": request_id, "recipient": request.recipient, "amount": request.amount, "agent": request.agent, "day": request.day, "rolled_back": rolled_back }),
            );
        }
        self.requests.insert(request_id.to_string(), request);
        transferred
    }
}
