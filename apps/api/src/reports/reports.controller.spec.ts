import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ListOwnReportsDto } from './dto/list-own-reports.dto';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

describe('ReportsController', () => {
  let controller: ReportsController;
  const create = jest.fn<ReportsService['create']>();
  const listOwn = jest.fn<ReportsService['listOwn']>();
  const findOwn = jest.fn<ReportsService['findOwn']>();
  const withdraw = jest.fn<ReportsService['withdraw']>();
  const request = { user: { id: 'token-user-id' } } as never;

  beforeEach(() => {
    for (const mock of [create, listOwn, findOwn, withdraw]) {
      mock.mockReset();
    }
    controller = new ReportsController({
      create,
      listOwn,
      findOwn,
      withdraw,
    } as unknown as ReportsService);
  });

  it('uses only the authenticated request user as reporter', async () => {
    const body = { username: 'target_user', reason: 'spam' } as never;
    await controller.create(body, request);

    expect(create).toHaveBeenCalledWith(body, 'token-user-id');
  });

  it('lists, reads and withdraws only as the authenticated request user', async () => {
    const query = new ListOwnReportsDto();
    await controller.listOwn(query, request);
    await controller.findOwn('report-1', request);
    await controller.withdraw('report-1', request);

    expect(listOwn).toHaveBeenCalledWith('token-user-id', query);
    expect(findOwn).toHaveBeenCalledWith('report-1', 'token-user-id');
    expect(withdraw).toHaveBeenCalledWith('report-1', 'token-user-id');
  });

  // Nest matches routes in declaration order: the collection must come first,
  // and any literal segment added later (GET /reports/<word>) must be declared
  // before GET :id, or :id captures it.
  it('declares GET /reports before GET /reports/:id, with no literal GET segment', () => {
    const prototype = ReportsController.prototype as unknown as Record<
      string,
      object
    >;
    const getRoutes = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .filter(
        (name) =>
          Reflect.getMetadata(METHOD_METADATA, prototype[name]) ===
          RequestMethod.GET,
      )
      .map(
        (name) => Reflect.getMetadata(PATH_METADATA, prototype[name]) as string,
      );

    expect(getRoutes).toEqual(['/', ':id']);
  });
});
