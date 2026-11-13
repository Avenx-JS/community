import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

// "An account's sessions changed": announced after a commit that ends
// sessions (logout, DELETE /auth/sessions/:id, logout-all, account deletion)
// or restricts an account. Live connections bound to a session (GET
// /notifications/stream) re-check theirs at once on this instance; other
// instances notice on their periodic re-check.
@Injectable()
export class SessionEvents {
  readonly changed = new Subject<string>();

  announce(userId: string): void {
    this.changed.next(userId);
  }
}
