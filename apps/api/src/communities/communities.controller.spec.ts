import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth/auth.service';
import { CommunitiesController } from './communities.controller';
import { CommunitiesService } from './communities.service';
import { CommunityStatsService } from './community-stats.service';
import { CommunityDiscoveryService } from './community-discovery.service';
import { NotificationPreferencesService } from './notification-preferences.service';

describe('CommunitiesController', () => {
  let controller: CommunitiesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommunitiesController],
      providers: [
        { provide: CommunitiesService, useValue: {} },
        { provide: NotificationPreferencesService, useValue: {} },
        { provide: CommunityStatsService, useValue: {} },
        { provide: CommunityDiscoveryService, useValue: {} },
        { provide: AuthService, useValue: {} },
      ],
    }).compile();

    controller = module.get<CommunitiesController>(CommunitiesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
