import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

describe('ReportsController', () => {
  let controller: ReportsController;
  const create = jest.fn<ReportsService['create']>();

  beforeEach(() => {
    create.mockReset();
    controller = new ReportsController({ create } as unknown as ReportsService);
  });

  it('uses only the authenticated request user as reporter', async () => {
    const body = { username: 'target_user', reason: 'spam' } as never;
    const request = { user: { id: 'token-user-id' } } as never;
    await controller.create(body, request);

    expect(create).toHaveBeenCalledWith(body, 'token-user-id');
  });
});
