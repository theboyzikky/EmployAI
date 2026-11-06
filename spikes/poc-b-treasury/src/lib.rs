// PoC-B spike (throwaway): minimal EmployAI treasury to prove the Windows toolchain and the
// contract-mediated payment pattern. NOT the production contract. Not deployed anywhere.
//
// Rules enforced on-chain:
//  - pay_order: deposit >= min_order; contributors' share (bps) transferred in the same call.
//  - request_payment: caller is the registered agent; not paused; recipient approved;
//    amount <= max_per_tx; daily total <= daily_cap; request_id never seen before.
//  - owner-only: pause / unpause / approve_recipient / set_agent.
use near_sdk::store::LookupSet;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise, PromiseResult};

const DAY_NS: u64 = 86_400_000_000_000;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Treasury {
    owner: AccountId,
    agent: Option<AccountId>,
    contributors: AccountId,
    split_bps: u16,
    min_order: NearToken,
    max_per_tx: NearToken,
    daily_cap: NearToken,
    day: u64,
    spent_today: NearToken,
    paused: bool,
    approved: LookupSet<AccountId>,
    processed: LookupSet<String>,
}

fn event(kind: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({"standard": "employai-treasury", "version": "0.1.0", "event": kind, "data": [data]})
    ));
}

#[near]
impl Treasury {
    #[init]
    pub fn new(
        owner: AccountId,
        contributors: AccountId,
        split_bps: u16,
        min_order: NearToken,
        max_per_tx: NearToken,
        daily_cap: NearToken,
    ) -> Self {
        require!(split_bps <= 10_000, "split_bps must be <= 10000");
        require!(max_per_tx <= daily_cap, "max_per_tx must be <= daily_cap");
        Self {
            owner, agent: None, contributors, split_bps, min_order, max_per_tx, daily_cap,
            day: env::block_timestamp() / DAY_NS, spent_today: NearToken::from_yoctonear(0), paused: false,
            approved: LookupSet::new(b"a"), processed: LookupSet::new(b"p"),
        }
    }

    fn assert_owner(&self) { require!(env::predecessor_account_id() == self.owner, "Only owner"); }

    // ---------------- owner actions
    pub fn set_agent(&mut self, agent: Option<AccountId>) { self.assert_owner(); self.agent = agent; }
    pub fn approve_recipient(&mut self, account: AccountId) { self.assert_owner(); self.approved.insert(account); }
    pub fn pause(&mut self) { self.assert_owner(); self.paused = true; event("paused", near_sdk::serde_json::json!({})); }
    pub fn unpause(&mut self) { self.assert_owner(); self.paused = false; event("unpaused", near_sdk::serde_json::json!({})); }

    // ---------------- sale with automatic revenue split
    #[payable]
    pub fn pay_order(&mut self, order_id: String) -> Promise {
        require!(!self.paused, "Paused");
        let deposit = env::attached_deposit();
        require!(deposit >= self.min_order, "Below minimum order value");
        let share = NearToken::from_yoctonear(deposit.as_yoctonear() * self.split_bps as u128 / 10_000);
        event("sale", near_sdk::serde_json::json!({"order_id": order_id, "payer": env::predecessor_account_id(), "amount": deposit, "contributors_share": share}));
        Promise::new(self.contributors.clone()).transfer(share)
    }

    // ---------------- agent payout (called with a function-call key scoped to this method)
    pub fn request_payment(&mut self, request_id: String, recipient: AccountId, amount: NearToken) -> Promise {
        require!(!self.paused, "Paused");
        require!(Some(env::predecessor_account_id()) == self.agent, "Not the registered agent");
        require!(self.approved.contains(&recipient), "Recipient not approved");
        require!(amount.as_yoctonear() > 0 && amount <= self.max_per_tx, "Amount over per-transaction limit");
        require!(!self.processed.contains(&request_id), "Duplicate request_id");
        let today = env::block_timestamp() / DAY_NS;
        if today != self.day { self.day = today; self.spent_today = NearToken::from_yoctonear(0); }
        let new_total = self.spent_today.checked_add(amount).unwrap_or_else(|| env::panic_str("Overflow"));
        require!(new_total <= self.daily_cap, "Daily cap exceeded");
        self.spent_today = new_total;
        self.processed.insert(request_id.clone());
        event("payout_requested", near_sdk::serde_json::json!({"request_id": request_id, "recipient": recipient, "amount": amount, "agent": env::predecessor_account_id()}));
        Promise::new(recipient.clone()).transfer(amount)
            .then(Self::ext(env::current_account_id()).on_payout(request_id, recipient, amount))
    }

    /// If the transfer failed (e.g. recipient deleted), roll back today's counter and record it.
    #[private]
    pub fn on_payout(&mut self, request_id: String, recipient: AccountId, amount: NearToken) -> bool {
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if !ok { self.spent_today = self.spent_today.saturating_sub(amount); }
        event(if ok { "payout_completed" } else { "payout_failed" }, near_sdk::serde_json::json!({"request_id": request_id, "recipient": recipient, "amount": amount}));
        ok
    }

    // ---------------- views
    pub fn get_policy(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({"owner": self.owner, "agent": self.agent, "contributors": self.contributors, "split_bps": self.split_bps,
            "min_order": self.min_order, "max_per_tx": self.max_per_tx, "daily_cap": self.daily_cap, "spent_today": self.spent_today, "paused": self.paused})
    }
    pub fn is_approved(&self, account: AccountId) -> bool { self.approved.contains(&account) }
    pub fn is_processed(&self, request_id: String) -> bool { self.processed.contains(&request_id) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId { s.parse().unwrap() }
    fn n(near: u128) -> NearToken { NearToken::from_near(near) }
    fn ms(milli: u128) -> NearToken { NearToken::from_millinear(milli) }
    fn ctx(pred: &str, deposit: NearToken, day: u64) {
        testing_env!(VMContextBuilder::new().current_account_id(acc("treasury.test.near")).predecessor_account_id(acc(pred))
            .attached_deposit(deposit).block_timestamp(day * DAY_NS + 1).build());
    }
    fn setup() -> Treasury {
        ctx("owner.near", NearToken::from_yoctonear(0), 100);
        // 10% to contributors; min order 0.5 NEAR; max 2 NEAR per tx; 3 NEAR per day
        let mut t = Treasury::new(acc("owner.near"), acc("contributors.near"), 1_000, ms(500), n(2), n(3));
        t.set_agent(Some(acc("finance-agent.near")));
        t.approve_recipient(acc("supplier-2.near"));
        t
    }

    #[test] fn sale_splits_revenue_and_logs_event() {
        let mut t = setup(); ctx("customer.near", n(1), 100);
        t.pay_order("o-1".into());
        let log = get_logs().join("\n");
        assert!(log.contains("\"event\":\"sale\"") && log.contains("\"contributors_share\":\"100000000000000000000000\""), "{log}");
    }
    #[test] #[should_panic(expected = "Below minimum order value")]
    fn sale_below_minimum_rejected() { let mut t = setup(); ctx("customer.near", ms(100), 100); t.pay_order("o-2".into()); }

    #[test] fn agent_pays_approved_recipient_within_limits() {
        let mut t = setup(); ctx("finance-agent.near", NearToken::from_yoctonear(0), 100);
        t.request_payment("r-1".into(), acc("supplier-2.near"), ms(1_200));
        assert!(t.is_processed("r-1".into()));
        assert!(get_logs().join("").contains("payout_requested"));
    }
    #[test] #[should_panic(expected = "Not the registered agent")]
    fn other_caller_rejected() { let mut t = setup(); ctx("attacker.near", NearToken::from_yoctonear(0), 100); t.request_payment("r".into(), acc("supplier-2.near"), n(1)); }
    #[test] #[should_panic(expected = "Recipient not approved")]
    fn unapproved_recipient_rejected_even_for_agent() { let mut t = setup(); ctx("finance-agent.near", NearToken::from_yoctonear(0), 100); t.request_payment("r".into(), acc("scam-supplier.near"), n(1)); }
    #[test] #[should_panic(expected = "Amount over per-transaction limit")]
    fn over_per_tx_rejected() { let mut t = setup(); ctx("finance-agent.near", NearToken::from_yoctonear(0), 100); t.request_payment("r".into(), acc("supplier-2.near"), ms(2_500)); }
    #[test] #[should_panic(expected = "Daily cap exceeded")]
    fn daily_cap_enforced() {
        let mut t = setup(); ctx("finance-agent.near", NearToken::from_yoctonear(0), 100);
        t.request_payment("r1".into(), acc("supplier-2.near"), n(2));
        t.request_payment("r2".into(), acc("supplier-2.near"), ms(1_500));
    }
    #[test] fn daily_cap_resets_next_day() {
        let mut t = setup(); ctx("finance-agent.near", NearToken::from_yoctonear(0), 100);
        t.request_payment("r1".into(), acc("supplier-2.near"), n(2));
        ctx("finance-agent.near", NearToken::from_yoctonear(0), 101);
        t.request_payment("r2".into(), acc("supplier-2.near"), n(2));
    }
    #[test] #[should_panic(expected = "Duplicate request_id")]
    fn duplicate_request_rejected() {
        let mut t = setup(); ctx("finance-agent.near", NearToken::from_yoctonear(0), 100);
        t.request_payment("r1".into(), acc("supplier-2.near"), ms(500));
        t.request_payment("r1".into(), acc("supplier-2.near"), ms(500));
    }
    #[test] #[should_panic(expected = "Paused")]
    fn pause_blocks_agent() {
        let mut t = setup(); t.pause(); ctx("finance-agent.near", NearToken::from_yoctonear(0), 100);
        t.request_payment("r".into(), acc("supplier-2.near"), ms(500));
    }
    #[test] #[should_panic(expected = "Only owner")]
    fn agent_cannot_unpause_or_change_policy() { let mut t = setup(); ctx("finance-agent.near", NearToken::from_yoctonear(0), 100); t.unpause(); }
    #[test] #[should_panic(expected = "Not the registered agent")]
    fn revoked_agent_rejected() {
        let mut t = setup(); t.set_agent(None); ctx("finance-agent.near", NearToken::from_yoctonear(0), 100);
        t.request_payment("r".into(), acc("supplier-2.near"), ms(500));
    }
}
