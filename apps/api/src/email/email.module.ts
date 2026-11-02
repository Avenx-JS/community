import { Module } from '@nestjs/common';
import { createEmailTransport } from './email-config';
import { EmailTransport } from './email-transport';

// Configuration is read when the provider is constructed, so an invalid or
// (in production) missing configuration fails application startup. Feature
// modules import EmailModule and inject EmailTransport without configuring it.
@Module({
  providers: [
    { provide: EmailTransport, useFactory: () => createEmailTransport() },
  ],
  exports: [EmailTransport],
})
export class EmailModule {}
