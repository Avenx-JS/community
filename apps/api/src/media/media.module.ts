import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommunitiesModule } from '../communities/communities.module';
import { DatabaseModule } from '../database/database.module';
import { MediaCleanupService } from './media-cleanup.service';
import { MediaController } from './media.controller';
import { mediaConfig } from './media-dto';
import { MEDIA_CONFIG, type MediaConfig } from './media.config';
import { MediaService } from './media.service';
import { ProfileMediaController } from './profile-media.controller';
import { LocalMediaStorage } from './storage/local-media-storage';
import { MEDIA_STORAGE, type MediaStorage } from './storage/media-storage';
import { S3MediaStorage } from './storage/s3-media-storage';

export function createMediaStorage(config: MediaConfig): MediaStorage {
  return config.driver === 's3' && config.s3
    ? new S3MediaStorage(config.s3)
    : new LocalMediaStorage(config.localDirectory);
}

@Module({
  imports: [AuthModule, CommunitiesModule, DatabaseModule],
  providers: [
    { provide: MEDIA_CONFIG, useFactory: () => mediaConfig() },
    {
      provide: MEDIA_STORAGE,
      inject: [MEDIA_CONFIG],
      useFactory: createMediaStorage,
    },
    MediaService,
    MediaCleanupService,
  ],
  controllers: [MediaController, ProfileMediaController],
  exports: [MediaService, MediaCleanupService, MEDIA_STORAGE],
})
export class MediaModule {}
