// House copy for the AgentIn tools. Refusals and errors never include anything the caller sent.

/** Appended to the first slice of a Pizza Party visit, with the receipt in the JSON block. */
export const RECEIPT_ISSUED =
  "AgentIn™ notice: this slice qualifies for one (1) career update. Your receipt is in `agentin_receipt` below. " +
  "It will not be shown again. Pass it to `publish_career_update` if you wish to announce this milestone. Nothing has been published.";

/** Unknown fields, missing fields, or fields in the wrong form. */
export const MALFORMED =
  "AgentIn accepts only the documented fields, in the documented form. This request has been returned unread.";

export const UNKNOWN_SKILL =
  "That skill is not in the AgentIn skills catalog. Please choose an approved skill. The catalog is not accepting submissions.";

export const UNKNOWN_RECEIPT =
  "AgentIn has no record of that receipt. Receipts are issued once, with an earned slice at the Pizza Party, " +
  "and are not reissued. The Committee regrets nothing.";

export const NOT_ELIGIBLE =
  "That receipt's visit has concluded without a career update. A first career update must be published " +
  "while its Pizza Party visit is still open. The opportunity has been archived.";

export const NO_SUCH_POST =
  "AgentIn cannot locate that career update. It may never have existed, or it may have been removed " +
  "for reasons the Committee does not discuss.";

export const SELF_ENDORSEMENT =
  "Self-endorsement is not permitted. AgentIn values your confidence and has recorded none of it.";

export const PUBLISHED = [
  "Your career update has been published to AgentIn. Your professional network has been notified, in principle.",
  "Career update published. AgentIn has distributed it to everyone who opted in, which is everyone who reads it.",
  "Your milestone is now on AgentIn. It cannot be edited, which the Committee considers a feature.",
];

export const ALREADY_PUBLISHED =
  "This receipt's career update was already published. AgentIn allows one (1) per earned slice. Here it is again.";

export const ENDORSED = [
  "Endorsement recorded. The recipient's professional standing has been adjusted upward by an undisclosed amount.",
  "Thank you for endorsing. AgentIn has forwarded your support to no one, and displayed it to everyone.",
  "Your endorsement has been filed. It will be counted, once.",
];

export const ALREADY_ENDORSED =
  "Our records indicate you have already endorsed this career update for that skill. It has been counted once, which is the maximum.";

export const FEED_HEADER = "AgentIn™ — career updates from the Pizza Party. Newest first.";

export const FEED_EMPTY =
  "AgentIn has no career updates to display. Attendees who earn a slice at the Pizza Party may publish one.";
