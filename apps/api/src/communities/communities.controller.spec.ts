import { Test, TestingModule } from '@nestjs/testing';
import { CommunitiesController } from './communities.controller';

describe('CommunitiesController', () => {
  let controller: CommunitiesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommunitiesController],
    }).compile();

    controller = module.get<CommunitiesController>(CommunitiesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
