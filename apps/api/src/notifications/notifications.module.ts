import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationStreamController } from './notification-stream.controller';
import { NotificationStreamService } from './notification-stream.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PushSubscriptionsController } from './push-subscriptions.controller';
import {
  fetchPushTransport,
  PUSH_CONFIG,
  PUSH_TRANSPORT,
  readPushConfig,
} from './web-push/push-config';
import { PushDispatcherService } from './web-push/push-dispatcher.service';
import { PushSubscriptionsService } from './web-push/push-subscriptions.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  // The stream first: NotificationsController's GET :id would capture it.
  controllers: [
    NotificationStreamController,
    NotificationsController,
    PushSubscriptionsController,
  ],
  providers: [
    NotificationInboxService,
    NotificationsService,
    NotificationStreamService,
    PushSubscriptionsService,
    PushDispatcherService,
    { provide: PUSH_CONFIG, useFactory: () => readPushConfig() },
    { provide: PUSH_TRANSPORT, useValue: fetchPushTransport },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
