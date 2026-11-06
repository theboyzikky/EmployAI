// M3.5 · Offline diagnostic playbooks. REVIEWED DATA, like the capability catalogue: each playbook
// recognises a common small-business problem, lists its POSSIBLE causes (never conclusions), and
// gives one diagnostic question per cause with simple answer classifiers. Each cause names the
// capabilities that would address it, so agent recommendations follow the cause, not a keyword.
// Restaurant: five playbooks in depth. Retail reuses the stock playbooks. Salon: one light playbook.
// Anything else gets an honest "I don't recognise that yet" (see reasoning.ts).
import type { CapabilityKey } from "@/lib/catalogue/catalogue";

export type PlaybookCause = {
  key: string;
  /** Plain words, completing "…because …" or "the cause is that …". */
  label: string;
  question: string;
  /** Used once if the first question wasn't answered. */
  rephrase: string;
  supports: RegExp;
  refutes?: RegExp;
  /** What a bare "yes" / "no" to this cause's question means. Omitted when the question isn't yes/no. */
  yes?: "supports" | "refutes";
  /** Matches the owner's own explanation, so their view is checked first. */
  ownerView?: RegExp;
  capabilities: CapabilityKey[];
  /** The improvement to suggest once this cause is confirmed or supported. */
  fix: string;
  fixDetail: string;
};

export type Playbook = {
  key: string;
  title: string;
  /** Industries it applies to; "any" includes an industry that isn't known yet. */
  industries: string[] | "any";
  symptom: RegExp;
  /** One sentence explaining why the consultant investigates instead of concluding. */
  reason: string;
  causes: PlaybookCause[];
  /** When no cause can be established: measure before automating. */
  measure: { capability: CapabilityKey | null; title: string; detail: string };
  /**
   * P6: one open question that can point to several causes at once, asked first when the owner hasn't
   * given their own explanation. `goal` is used for the problem behind a stated goal.
   */
  opening?: { goal: string; problem: string; rephrase: string };
};

const RESTAURANT = "Restaurant / food service";
const RETAIL = "Retail";
const SALON = "Salon / beauty services";

export const PLAYBOOKS: Playbook[] = [
  {
    key: "overbuying",
    title: "Buying more stock than is used",
    industries: [RESTAURANT, RETAIL],
    symptom: /\b(buy(?:ing)? too much|buys too much|over-?(?:buy|order|stock)(?:ing|s)?|too much stock|excess (?:stock|inventory)|(?:stock|food|ingredients?) (?:goes?|going) (?:bad|off|to waste)|spoil(?:s|ed|ing|age)?|expir(?:e|es|ed|ing)|throw(?:ing)? (?:away|out) (?:food|stock)|food waste|wasted? (?:food|stock|ingredients))\b/i,
    reason: "Buying too much has several possible causes, and each needs a different fix, so I'd like to check before suggesting anything.",
    causes: [
      { key: "spoilage", label: "stock spoils or expires before it's used",
        question: "When stock goes unused, what usually happens to it: does it spoil or expire before you can use it, or does it just pile up?",
        rephrase: "Does any of your stock go bad before you get to use it?",
        supports: /spoil|expire|go(?:es)? (?:bad|off)|rot|throw (?:it |them )?(?:away|out)|perish|fresh produce|wast/i,
        refutes: /pile(?:s)? up|doesn'?t (?:go bad|spoil)|keeps? (?:well|fine)|nothing goes bad|no waste/i, yes: "supports",
        capabilities: ["inventory_tracking"], fix: "Track perishable stock and use the oldest first", fixDetail: "Flag items close to going bad, so they're used or not re-bought." },
      { key: "no_check", label: "purchases are made without checking what's already in stock",
        question: "Who decides how much to buy, and do they check what's already in stock before buying?",
        rephrase: "Before buying, does anyone check how much is left?",
        supports: /don'?t check|without checking|never check|no(?:body| one) checks?|same (?:amount|quantity)|by habit|just buy|guess/i,
        refutes: /(?:we|i|they) (?:always )?check|count (?:it |the stock )?(?:first|before)|look at (?:the |what'?s )?(?:stock|left)/i, yes: "refutes",
        capabilities: ["inventory_tracking", "procurement"], fix: "Check stock before every purchase and suggest how much to buy", fixDetail: "Purchases start from what's actually left, not habit." },
      { key: "demand", label: "demand changes from day to day and the same amount is bought anyway",
        question: "Does demand change much from day to day, for example quieter weekdays and busier weekends?",
        rephrase: "Are some days of the week much busier than others?",
        supports: /weekend|busier|quiet(?:er)?|varies|changes|depends|double|half|slow (?:days?|weeks?)|unpredictable|season/i,
        refutes: /same every day|steady|constant|doesn'?t change|about the same/i, yes: "supports",
        capabilities: ["inventory_tracking"], fix: "Suggest quantities from recent sales, by day of the week", fixDetail: "Buy less before quiet days and enough before busy ones." },
      { key: "supplier_extra", label: "suppliers deliver more than was ordered",
        question: "When deliveries arrive, do you check them against what you ordered, and do suppliers ever send more than you asked for?",
        rephrase: "Do suppliers ever send more than you ordered?",
        supports: /send(?:s)? more|extra|more than (?:we|i) (?:asked|ordered|need)|over-?deliver|minimum order|bulk|don'?t check (?:the )?deliver/i,
        refutes: /exactly what|always (?:correct|right)|(?:we|i) check (?:every |each )?deliver|never (?:send|sent) more/i,
        capabilities: ["procurement", "finance_payments"], fix: "Check deliveries against orders and pay only for what was received", fixDetail: "Extra quantities are caught before they're paid for." },
      { key: "records", label: "stock records are inaccurate, so purchases are guesses",
        question: "How do you keep track of what's in stock today: regular counts, a notebook or an app, or from memory?",
        rephrase: "Do you keep any record of how much stock you have?",
        supports: /memory|in my head|guess|don'?t (?:track|count|record|write)|no records?|not sure (?:what|how much)|roughly/i,
        refutes: /count (?:it |the stock )?(?:daily|every|each)|spreadsheet|app|system|\bpos\b|record (?:it |everything )?(?:daily|every)/i, yes: "refutes",
        capabilities: ["inventory_tracking"], fix: "Keep a running stock count that every purchase and sale updates", fixDetail: "Decisions start from accurate numbers." },
    ],
    measure: { capability: "inventory_tracking", title: "Measure first: record what is bought, used and thrown away", detail: "For two weeks, so the real cause of overbuying becomes visible before anything is automated." },
  },
  {
    key: "running_out",
    title: "Running out of stock",
    industries: [RESTAURANT, RETAIL],
    symptom: /\b(run(?:ning)? out|ran out|runs out|out of stock|stock-?outs?|short of|not enough (?:stock|ingredients))\b/i,
    reason: "Running out can have quite different causes, so I'd like to understand which one applies before suggesting a fix.",
    causes: [
      { key: "manual_ordering", label: "reordering by phone or in person takes time and gets delayed",
        question: "When stock runs low, how long does it take from noticing to actually placing the order, and what gets in the way?",
        rephrase: "Do reorders ever get delayed because placing them takes time?",
        supports: /forget|busy|no time|can'?t reach|hours|takes? (?:time|long|ages)|later|wait(?:ing)? for|delay|call(?:s|ing)?|phone/i,
        refutes: /immediately|right away|straight away|few minutes|minutes/i, yes: "supports",
        ownerView: /phone|call|by hand|manual|market|whats\s?app|in person|go to/i,
        capabilities: ["procurement", "inventory_tracking"], fix: "Prepare reorders for approved suppliers as soon as stock is low", fixDetail: "Reorders no longer wait for someone to find time to call." },
      { key: "late_reorder", label: "low stock isn't noticed until it's too late",
        question: "How do you know when it's time to reorder: is there a set level you check, or do you notice when it's nearly gone?",
        rephrase: "Is there a set level at which you reorder each item?",
        supports: /notice|when (?:it'?s|it is) (?:gone|finished|empty|nearly)|too late|no set|don'?t check|when (?:we|i) run out|last minute|by the time/i,
        refutes: /set level|reorder (?:point|level)|check (?:it |the stock )?(?:daily|every)|when it (?:gets|drops) (?:to|below)/i, yes: "refutes",
        capabilities: ["inventory_tracking"], fix: "Flag items as they fall below their reorder point", fixDetail: "Low stock is seen early enough to reorder." },
      { key: "supplier_delay", label: "suppliers deliver late",
        question: "Once you've ordered, does the supplier deliver on time, or do delays cause the shortage?",
        rephrase: "Do suppliers ever deliver later than promised?",
        supports: /late|delay|takes? (?:days|long|a while)|unreliable|doesn'?t (?:come|deliver)|wait(?:ing)? (?:days|for)/i,
        refutes: /on time|same day|next day|reliable|quickly|fast/i, yes: "supports",
        capabilities: ["procurement"], fix: "Compare supplier delivery times and suggest reliable alternatives", fixDetail: "Shortages caused by slow suppliers are avoided." },
      { key: "demand_spikes", label: "unexpectedly busy days use up stock",
        question: "Do you mostly run out on unexpectedly busy days, or on normal days too?",
        rephrase: "Is running out linked to busy days?",
        supports: /busy (?:days?|weekends?|evenings?|periods?|times?)|weekends?|unexpected|surprise|rush|big orders?|events?|holiday/i,
        refutes: /normal days|any day|all the time|even (?:on )?quiet/i, yes: "supports",
        capabilities: ["inventory_tracking"], fix: "Raise reorder levels ahead of busy days", fixDetail: "Stock is topped up before demand peaks." },
      { key: "cash_limits", label: "available cash limits how much can be bought",
        question: "Is how much you can buy ever limited by the cash available at the time?",
        rephrase: "Does cash ever stop you buying enough?",
        supports: /cash|money|afford|can'?t pay|budget|tight|credit/i,
        refutes: /not an issue|cash is fine|never/i, yes: "supports",
        capabilities: ["finance_payments"], fix: "Plan purchases against cash and supplier payment dates", fixDetail: "Buying is planned around when money is available." },
    ],
    measure: { capability: "inventory_tracking", title: "Measure first: record when each item runs out and when it was reordered", detail: "So the gap between running low and restocking can be seen." },
  },
  {
    key: "missed_orders",
    title: "Missed or lost customer orders",
    industries: [RESTAURANT],
    symptom: /\b(miss(?:ed|ing)? (?:\w+ )?orders?|lost orders?|forget(?:ting)? (?:\w+ )?orders?|orders? (?:get|go|are|were) (?:missed|lost|forgotten)|mix(?:ed)?[- ]?up (?:the )?orders?|wrong orders?)\b/i,
    reason: "Orders go missing for different reasons, so I'd like to see where they slip through.",
    causes: [
      { key: "peak_load", label: "orders arrive when everyone is too busy to handle them",
        question: "Do orders get missed mostly at busy times, when everyone is cooking or serving?",
        rephrase: "Are the missed orders mostly at busy times?",
        supports: /busy|rush|peak|evening|lunch|weekend|cooking|no time/i,
        refutes: /quiet|any time|not busy/i, yes: "supports",
        capabilities: ["order_intake"], fix: "Capture and confirm orders automatically, even at busy times", fixDetail: "No order depends on someone being free to read it." },
      { key: "channel_overload", label: "orders come in on several channels and get buried",
        question: "Where do the missed orders usually come from: WhatsApp or phone messages, the counter, or delivery apps?",
        rephrase: "Do the missed orders mostly come in by message?",
        supports: /whats\s?app|messages?|\bdms?\b|phone|calls?|instagram|several|different (?:places|channels)/i,
        refutes: /counter only|only (?:at )?the counter|in person/i, yes: "supports",
        ownerView: /whats\s?app|messages?|phone|calls?|instagram|channels?/i,
        capabilities: ["order_intake", "customer_messaging"], fix: "Collect orders from every channel into one list", fixDetail: "Messages and calls become orders that can't be overlooked." },
      { key: "no_single_list", label: "there's no single list of open orders",
        question: "Once an order comes in, where is it written down so the kitchen sees it?",
        rephrase: "Is there one place where every open order is listed?",
        supports: /memory|remember|in my head|nowhere|not written|scattered|my phone|chat/i,
        refutes: /ticket|board|system|\bpos\b|written down|list/i, yes: "refutes",
        capabilities: ["order_intake"], fix: "Keep one list of open orders the kitchen can follow", fixDetail: "Every order is visible until it's done." },
      { key: "handoff", label: "orders are taken but not passed on to the kitchen",
        question: "Are orders ever taken correctly but then not passed on to the kitchen?",
        rephrase: "Do orders ever get lost between taking them and cooking them?",
        supports: /forgot to tell|not passed|kitchen (?:didn'?t|did not) (?:get|know)|handover|hand-?off/i,
        refutes: /always passed/i, yes: "supports",
        capabilities: ["order_intake"], fix: "Pass every confirmed order to the kitchen automatically", fixDetail: "Nothing is lost between the counter and the kitchen." },
    ],
    measure: { capability: "order_intake", title: "Measure first: log every order and where it came from", detail: "So it becomes clear where orders slip through." },
  },
  {
    key: "slow_service",
    title: "Slow service",
    industries: [RESTAURANT],
    symptom: /\b(slow service|service is slow|customers? (?:wait|waiting) (?:too )?long|long waits?|long queues?|takes? too long to (?:serve|cook|prepare)|orders? (?:are|come out) (?:slow|late)|kitchen is slow)\b/i,
    reason: "Slow service usually comes down to a few different bottlenecks, and they need different fixes.",
    causes: [
      { key: "understaffed_peak", label: "there aren't enough people on shift at peak times",
        question: "Is it slow mainly at peak times when there aren't enough people on shift?",
        rephrase: "Is service slow mostly at peak times?",
        supports: /peak|busy|lunch|evening|weekend|not enough (?:staff|people|hands)|short-?staffed/i,
        refutes: /all day|even when quiet|enough staff/i, yes: "supports",
        capabilities: [], fix: "Plan shifts around the busiest hours", fixDetail: "A staffing change, not an AI agent." },
      { key: "order_taking", label: "taking and confirming orders takes too long",
        question: "How long does it take to take an order and confirm it with the customer, especially on WhatsApp or the phone?",
        rephrase: "Does taking orders by message or phone slow things down?",
        supports: /long|ages|minutes|back and forth|questions|slow to reply|phone|whats\s?app/i,
        refutes: /quick|fast|seconds|no problem/i, yes: "supports",
        capabilities: ["order_intake", "customer_messaging"], fix: "Take and confirm orders automatically", fixDetail: "Staff spend their time cooking and serving instead." },
      { key: "prep", label: "food isn't prepared ahead of busy periods",
        question: "Is food prepared ahead of busy periods, or mostly cooked from scratch when ordered?",
        rephrase: "Do you prepare popular dishes before the rush?",
        supports: /scratch|when ordered|not (?:prepared|ready)|no prep|on the spot/i,
        refutes: /prepare(?:d)? ahead|prep (?:in the morning|before)|ready before/i, yes: "refutes",
        capabilities: [], fix: "Prepare popular dishes ahead of busy periods", fixDetail: "A kitchen routine change, not an AI agent." },
      { key: "mid_service_stockouts", label: "items run out in the middle of service",
        question: "Does service slow down because something runs out in the middle of service?",
        rephrase: "Do ingredients ever run out during service?",
        supports: /run(?:s|ning)? out|ran out|out of|missing ingredients/i,
        refutes: /never runs? out/i, yes: "supports",
        capabilities: ["inventory_tracking"], fix: "Warn before popular items run out during service", fixDetail: "Stock is topped up before it causes delays." },
    ],
    measure: { capability: null, title: "Measure first: time orders from arrival to serving for a week", detail: "So the slowest step can be seen." },
  },
  {
    key: "low_profit",
    title: "Losing money or low profit",
    industries: [RESTAURANT, RETAIL],
    symptom: /\b(los(?:e|es|ing|t) money|not making (?:any )?(?:money|profit)|(?:low|no|small) (?:profit|margins?)|profits? (?:are|is) (?:low|down|falling)|cash ?flow|can'?t pay (?:the )?(?:bills|suppliers|staff)|lose track of (?:\w+ )?(?:money|payments?|spending|costs?|what (?:i|we)(?:'ve)? paid)|costs? (?:are|keep) (?:rising|going up|too high))\b/i,
    reason: "Losing money can come from costs, prices, waste or untracked spending, and each needs a different fix.",
    causes: [
      { key: "untracked_spending", label: "spending and supplier payments aren't tracked",
        question: "How do you keep track of what you spend and pay suppliers: receipts, a notebook, an app, or not really?",
        rephrase: "Do you keep a record of every supplier payment?",
        supports: /not really|don'?t|cash|memory|in my head|no records?|lose track|receipts? (?:get )?lost|nothing/i,
        refutes: /spreadsheet|app|accountant|book-?keeping|every payment|record (?:every|each)/i, yes: "refutes",
        ownerView: /cash|no records?|don'?t (?:track|record|write)|lose track/i,
        capabilities: ["finance_payments"], fix: "Record every supplier payment and cost automatically", fixDetail: "You can see where the money goes." },
      { key: "costs_rising", label: "supplier prices have gone up without menu prices changing",
        question: "Have the prices you pay suppliers gone up recently without your menu prices changing?",
        rephrase: "Have your ingredient costs gone up recently?",
        supports: /gone up|went up|increase|higher|more expensive|inflation|risen/i,
        refutes: /same|stable|haven'?t changed|not changed/i, yes: "supports",
        capabilities: ["procurement"], fix: "Compare supplier prices and flag cost increases", fixDetail: "Cost rises are noticed and acted on." },
      { key: "pricing", label: "menu prices don't cover what each dish costs to make",
        question: "Do you know roughly how much each dish costs you to make compared with what you charge?",
        rephrase: "Have you worked out what each dish costs you to make?",
        supports: /no idea|not sure|don'?t know|never (?:worked|calculated)|guess/i,
        refutes: /(?:we|i) know|calculated|worked (?:it )?out|margin is/i, yes: "refutes",
        capabilities: ["finance_payments"], fix: "Work out the cost of each dish and show its margin", fixDetail: "Prices can be set with the real cost in view." },
      { key: "waste", label: "food is wasted",
        question: "How much food gets thrown away in a typical week?",
        rephrase: "Does a noticeable amount of food get thrown away?",
        supports: /a lot|lots|plenty|much|every day|bags?|spoil|go(?:es)? bad|wast/i,
        refutes: /little|hardly|almost none|none|nothing/i, yes: "supports",
        capabilities: ["inventory_tracking"], fix: "Track waste and adjust how much is bought", fixDetail: "Less money ends up in the bin." },
    ],
    measure: { capability: "finance_payments", title: "Measure first: record every sale and cost for two weeks", detail: "So it becomes clear where the money is lost." },
  },
  {
    key: "no_shows",
    title: "No-shows and double bookings",
    industries: [SALON],
    symptom: /\b(no-?shows?|double[- ]book(?:ings?|ed)?|missed appointments?|(?:clients?|customers?) (?:keep )?(?:don'?t|do not|not) (?:show(?:ing)?|turn(?:ing)?) up|last[- ]minute cancell?ations?)\b/i,
    reason: "No-shows and double bookings usually have simple causes, so I'd like to check which one applies.",
    causes: [
      { key: "no_reminders", label: "clients don't get a reminder before their appointment",
        question: "Do clients get a reminder before their appointment?", rephrase: "Do you remind clients the day before?",
        supports: /never|not always|sometimes|forget/i, refutes: /^(?:yes|always)\b|(?<!not )\balways (?:send|remind)|\bwe (?:always )?send\b/i, yes: "refutes",
        capabilities: ["bookings", "customer_messaging"], fix: "Send reminders before every appointment", fixDetail: "Fewer clients forget." },
      { key: "scattered_bookings", label: "bookings are recorded in several places",
        question: "Where are bookings recorded: one calendar, or across WhatsApp, calls and a diary?", rephrase: "Are all bookings in one place?",
        supports: /whats\s?app|calls?|diary|paper|different|several|across/i, refutes: /one calendar|booking page|system/i, yes: "refutes",
        capabilities: ["bookings"], fix: "Keep every booking in one calendar", fixDetail: "Double bookings become impossible." },
    ],
    measure: { capability: "bookings", title: "Measure first: log no-shows and how each booking was made", detail: "So the pattern behind them can be seen." },
  },
  {
    // P6 · cross-industry (Q9). Listed LAST so specific playbooks (missed orders…) win. Also investigates
    // the problem behind a stated goal such as "automate my chat replies". Capabilities depend on whether
    // the messages are orders (Order Agent) or enquiries (Customer Messages Agent): see enquiryCapabilities.
    key: "enquiries",
    title: "Handling client messages and enquiries",
    industries: "any",
    symptom: /\b(spend(?:s|ing)? (?:\w+ ){0,3}(?:hours?|ages|all day|all evening|the whole (?:day|evening)|too much time) (?:\w+ ){0,2}(?:answering|replying|responding|on (?:whats\s?app|messages|the phone|chats?))|(?:too many|so many|lots of|loads of) (?:messages|enquiries|inquiries|dms|questions|chats)|slow to (?:reply|respond)|can'?t keep up with (?:the )?(?:messages|enquiries|dms|chats)|miss(?:ed|ing)? (?:\w+ )?(?:messages|enquiries|inquiries|dms|leads)|(?:answer|answering|reply|replying) (?:to )?the same questions)\b/i,
    reason: "Replying to clients can eat up time for quite different reasons, so I'd like to see which one applies.",
    opening: {
      goal: "What's making you want this: replies taking too long, messages arriving when you can't answer, or the same questions coming up again and again?",
      problem: "What takes the most time: the same questions again and again, the back and forth to settle each one, or simply the number of messages?",
      rephrase: "Is it mostly the same questions, messages at awkward hours, or just the volume?",
    },
    causes: [
      { key: "repetitive", label: "most messages are the same routine questions",
        question: "Are most of the messages the same few questions, such as prices, availability or how to order?",
        rephrase: "Do you find yourself typing the same answers again and again?",
        supports: /same (?:few |old )?(?:questions?|things?|answers?)|again and again|over and over|repeat|routine|typing the same|prices?|availab|how much|still (?:available|there)|how to (?:order|book)/i,
        refutes: /(?:all|each one is|they'?re all) different|unique|complicated|no two/i, yes: "supports",
        capabilities: ["customer_messaging"], fix: "Answer routine questions automatically and hand the rest to you", fixDetail: "Common questions get an instant, consistent answer; you see only the ones that need you." },
      { key: "after_hours", label: "messages arrive when no one is free to reply",
        question: "Do many messages arrive when no one can reply, such as evenings, weekends or while you're busy with something else?",
        rephrase: "Do messages often wait hours before anyone can answer?",
        supports: /evenings?|nights?|late|weekends?|after hours|midnight|early morning|while (?:i'?m|we'?re|i am|we are)|busy|can'?t (?:reply|answer)|no one|nobody/i,
        refutes: /during (?:the day|office hours|working hours)|(?:someone|always someone) (?:is )?(?:available|there)/i, yes: "supports",
        capabilities: ["customer_messaging"], fix: "Reply to messages at any hour and pass anything unusual to you", fixDetail: "Nobody waits until morning for a simple answer." },
      { key: "back_and_forth", label: "each one takes a lot of back and forth to settle",
        question: "Does each one take a lot of back and forth before it's settled, for example confirming details, addresses or payment?",
        rephrase: "Do you have to send several messages to settle each one?",
        supports: /back and forth|several messages|confirm(?:ing)?|address(?:es)?|payment details|details|clarif|change their (?:mind|order)|long (?:chats?|conversations?)/i,
        refutes: /one message|straightforward|quick/i, yes: "supports",
        capabilities: ["customer_messaging"], fix: "Collect every detail in one guided exchange", fixDetail: "Each request is settled in one go instead of a long chat." },
      { key: "volume", label: "there are more messages than one person can keep up with",
        question: "Is it mainly the sheer number of messages, more than you can keep up with?",
        rephrase: "Are there simply too many messages for one person?",
        supports: /too many|so many|hundreds|dozens|loads|flood|can'?t keep up|overwhelm|number of messages|volume/i,
        refutes: /not (?:that )?many|only a few|manageable/i, yes: "supports",
        capabilities: ["customer_messaging"], fix: "Answer and sort incoming messages so only the ones that need you reach you", fixDetail: "The volume stops landing on one person." },
      { key: "slow_replies", label: "slow replies lose clients",
        question: "Do people go elsewhere when replies are slow?",
        rephrase: "Have you lost a sale or a client because a reply came too late?",
        supports: /lose (?:clients|customers|leads|sales|business)|lost (?:clients|customers|leads|sales)|go elsewhere|move on|another (?:agent|shop|seller)|competitor|too slow/i,
        refutes: /they wait|patient|don'?t mind/i, yes: "supports",
        capabilities: ["customer_messaging"], fix: "Reply within minutes, so enquiries aren't lost", fixDetail: "Clients get an answer while they're still interested." },
    ],
    measure: { capability: "customer_messaging", title: "Measure first: for a week, note each message, what it asked and how long the reply took", detail: "So it becomes clear where replying takes the time." },
  },
];

/** For the enquiries playbook: messages that are ORDERS call for the Order Agent, other enquiries for the Customer Messages Agent. */
export const enquiryCapabilities = (text: string): CapabilityKey[] => (/\borders?\b|\bordering\b/i.test(text) ? ["order_intake"] : ["customer_messaging"]);

/**
 * DIRECT STATEMENTS of each cause (audit fix). A cause the consultant did NOT ask about can be supported
 * only by the owner stating that cause itself, never by a passing word: naming Instagram doesn't mean
 * "orders get buried across channels", and "we're open at weekends" doesn't mean "busy days use up
 * stock". The broad `supports` patterns apply only to the answer to that cause's own question, or to the
 * open question about what drives a goal or problem. A cause missing here gets no side evidence at all.
 */
const STATES: Record<string, RegExp> = {
  "overbuying:spoilage": /\b(?:goes|go|went|going) (?:bad|off)\b|\bspoil(?:s|ed|ing|age)?\b|\bexpire[sd]?\b|\brot(?:s|ting)?\b|\bthrow(?:ing)? (?:it |them |food |stock )?(?:away|out)\b/i,
  "overbuying:no_check": /\b(?:don'?t|never|without) check(?:ing)? (?:what'?s (?:left|in stock)|the stock|stock)|\bbuy(?:ing)? the same (?:amount|quantity)\b|\bby habit\b/i,
  "overbuying:demand": /\bdemand (?:changes|varies|is unpredictable)|\b(?:some days|weekdays|weekends) are (?:much )?(?:busier|quieter)\b/i,
  "overbuying:supplier_extra": /\b(?:suppliers?|they) (?:send|sent|deliver(?:s|ed)?) (?:us )?(?:more|extra)\b|\bmore than (?:we|i) (?:ordered|asked for)\b/i,
  "overbuying:records": /\b(?:no|don'?t keep(?: any)?) (?:stock )?records?\b|\bdon'?t (?:count|track) (?:the )?stock\b|\bfrom memory\b|\bin my head\b/i,
  "running_out:manual_ordering": /\bforget to (?:call|order|reorder)\b|\bno time to (?:call|order|reorder)\b|\b(?:reordering|calling (?:the )?suppliers?) takes (?:time|hours|ages)\b/i,
  "running_out:late_reorder": /\b(?:only )?notice (?:when|too late)\b|\b(?:until|when) (?:it'?s|it is) (?:gone|finished|empty)\b|\bno (?:set|reorder) (?:level|point)\b/i,
  "running_out:supplier_delay": /\bsuppliers? (?:\w+ ){0,2}(?:late|delayed|unreliable)\b|\bdeliver(?:y|ies) (?:are |is |come |comes )?(?:late|delayed)\b|\bwait(?:ing)? (?:days|ages) for (?:the )?(?:supplier|delivery)\b/i,
  "running_out:demand_spikes": /\brun out (?:on|at|during) (?:busy|unexpectedly busy)\b|\bunexpectedly busy\b|\bbig (?:orders?|events?) (?:use|finish|wipe)/i,
  "running_out:cash_limits": /\b(?:can'?t|cannot|couldn'?t) afford\b|\bnot enough (?:cash|money)\b|\bcash is (?:tight|short)\b/i,
  "missed_orders:peak_load": /\b(?:miss|lose|forget)\w* (?:\w+ ){0,3}orders? (?:when|while|at|during|on) (?:busy|peak|rush|lunch)\b|\btoo busy to (?:answer|reply|read|check|take)\b/i,
  "missed_orders:channel_overload": /\b(?:orders?|messages?) (?:get |are |go )?(?:lost|buried|missed) (?:in|across|between|among)\b|\b(?:too many|several|different|so many) (?:apps|channels|places|platforms)\b|\bkeep track (?:of|across) (?:all )?(?:the )?(?:apps|channels|chats)\b/i,
  "missed_orders:no_single_list": /\bno (?:single )?list of (?:open )?orders\b|\borders? (?:aren'?t|are not) written down\b|\borders? in my head\b/i,
  "missed_orders:handoff": /\bforg(?:e|o)t to tell the kitchen\b|\b(?:not|never) passed (?:on )?to the kitchen\b|\bkitchen (?:didn'?t|did not|doesn'?t) (?:get|know|see)\b/i,
  "slow_service:understaffed_peak": /\b(?:short|under)[- ]?staffed\b|\bnot enough (?:staff|people|hands)\b/i,
  "slow_service:order_taking": /\btaking (?:orders?|an order) takes (?:too )?(?:long|ages)\b|\bconfirming (?:each |every )?orders? takes\b/i,
  "slow_service:prep": /\bfrom scratch\b|\bnot (?:prepared|prepped) (?:ahead|in advance)\b/i,
  "slow_service:mid_service_stockouts": /\brun(?:s|ning)? out (?:\w+ ){0,3}(?:during|in the middle of) (?:service|the rush|lunch)\b/i,
  "low_profit:untracked_spending": /\b(?:don'?t|never|no) (?:track|record|write down|keep (?:track|records?) of) (?:\w+ ){0,2}(?:spending|payments?|costs?|receipts?|expenses)\b|\blose track of (?:\w+ )?(?:money|payments?|spending|costs?)\b|\breceipts? (?:get |are )?lost\b/i,
  "low_profit:costs_rising": /\b(?:supplier|ingredient|food) (?:prices|costs) (?:have |has )?(?:gone up|went up|risen|increased)\b|\b(?:prices|costs) (?:have |has )?(?:gone up|risen|increased) (?:but|without)\b/i,
  "low_profit:pricing": /\b(?:don'?t|do not) know (?:how much|what) (?:each |a )?(?:dish|item|plate) costs\b|\bnever (?:worked out|calculated) (?:the )?costs?\b/i,
  "low_profit:waste": /\bthrow(?:ing)? (?:away|out) (?:\w+ )?food\b|\bfood (?:goes|is) (?:to waste|wasted)\b|\ba lot of waste\b/i,
  "no_shows:no_reminders": /\b(?:don'?t|never|no) (?:send|get|give) (?:any )?reminders?\b|\bforget to remind\b/i,
  "no_shows:scattered_bookings": /\bbookings? (?:are )?(?:all )?over the place\b|\bbookings? (?:in|across) (?:several|different) (?:places|apps)\b/i,
  "enquiries:repetitive": /\bsame (?:few |old )?questions?\b|\bagain and again\b|\bover and over\b|\brepeat(?:ing)? myself\b|\btyping the same\b/i,
  "enquiries:after_hours": /\b(?:messages?|enquiries|chats?|they)\b(?: \w+){0,4} (?:come|comes|arrive|arrives|pile up)(?: \w+){0,2} (?:at night|late at night|in the evenings?|on weekends|after hours|while (?:i'?m|we'?re) (?:busy|asleep|away))\b|\bcan'?t (?:reply|answer|respond) (?:until|at night|in the evenings?)\b/i,
  "enquiries:back_and_forth": /\bback and forth\b|\bseveral messages to (?:confirm|settle)\b/i,
  "enquiries:volume": /\btoo many (?:messages|chats|enquiries)\b|\bcan'?t keep up (?:with )?(?:the )?(?:messages|chats|enquiries)\b|\bhundreds of (?:messages|chats)\b/i,
  "enquiries:slow_replies": /\b(?:lose|lost|losing) (?:clients|customers|leads|sales) (?:because|when|if)\b|\bgo(?:es)? elsewhere when\b/i,
};
/** Does this text state cause `key` of playbook `pb` itself (not just mention a related word)? */
export const statesCause = (pb: Playbook, key: string, text: string) => !!STATES[`${pb.key}:${key}`]?.test(text);

export const playbookByKey = (k: string | null | undefined) => PLAYBOOKS.find(p => p.key === k) ?? null;
export const causeOf = (pb: Playbook, key: string) => pb.causes.find(c => c.key === key) ?? null;

/** The playbook that recognises this text for this industry (null industry: restaurant and retail playbooks apply). */
export function matchPlaybook(text: string, industry: string | null): Playbook | null {
  return PLAYBOOKS.find(p => (p.industries === "any" || (industry ? p.industries.includes(industry) : !p.industries.includes(SALON))) && p.symptom.test(text)) ?? null;
}

export const YES = /^(?:yes|yeah|yep|yup|definitely|exactly|correct|that'?s (?:right|true|it)|true|it does|they do|we do|i do|it is|indeed|sure|absolutely|mostly|often)\b/i;
export const NO = /^(?:no|nope|not really|never|it doesn'?t|they don'?t|we don'?t|i don'?t|not at all|not usually|rarely)\b/i;
export const PARTLY = /^(?:partly|sometimes|a bit|somewhat|kind of|sort of|maybe|in part)\b/i;
