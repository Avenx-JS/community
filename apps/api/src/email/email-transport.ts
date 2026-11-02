export interface OutboundMessage {
  to: string;
  subject: string;
  text: string;
}

// The abstract class is the DI token, as MYSQL_POOL is for the database:
// consumers inject EmailTransport and never name an implementation.
//
// send rejects on failure and does not retry. A consumer must catch the
// rejection, log it without the message body, and return its normal
// response; reporting the failure would let callers tell "unknown address"
// apart from "delivery failed".
export abstract class EmailTransport {
  abstract send(message: OutboundMessage): Promise<void>;
}
