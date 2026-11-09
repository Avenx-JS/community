import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from '@jest/globals';
import { REQUIRED_PLATFORM_ROLES } from '../auth/requires-role.decorator';
import { AdminReportsController } from './admin-reports.controller';
import { REPORT_ASSIGNEE_ROLES } from './admin-reports.service';

const prototype = AdminReportsController.prototype as unknown as Record<
  string,
  object
>;
const handlers = Object.getOwnPropertyNames(prototype).filter(
  (name) => name !== 'constructor',
);
const routes = handlers.map((name) => ({
  name,
  method: Reflect.getMetadata(
    METHOD_METADATA,
    prototype[name],
  ) as RequestMethod,
  path: Reflect.getMetadata(PATH_METADATA, prototype[name]) as string,
}));

describe('AdminReportsController', () => {
  // AdminGuard falls back to ['admin'] when no @RequiresRole is set. An
  // assignee must hold a role the guard admits, or they could not open the
  // report they own; widening the guard must widen REPORT_ASSIGNEE_ROLES too.
  it('admits exactly REPORT_ASSIGNEE_ROLES through AdminGuard', () => {
    const rolesOf = (target: object) =>
      Reflect.getMetadata(REQUIRED_PLATFORM_ROLES, target) as
        string[] | undefined;
    const declared = [
      rolesOf(AdminReportsController),
      ...handlers.map((name) => rolesOf(prototype[name])),
    ].filter((roles) => roles !== undefined);
    expect(declared).toEqual([]);
    expect(REPORT_ASSIGNEE_ROLES).toEqual(['admin']);
  });

  it('assigns with POST and unassigns with DELETE on :id/assign', () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        { name: 'assign', method: RequestMethod.POST, path: ':id/assign' },
        { name: 'unassign', method: RequestMethod.DELETE, path: ':id/assign' },
      ]),
    );
  });

  // PATCH :id already resolves and rejects; a second path would mean two code
  // paths for one state machine.
  it('has no /resolve or /dismiss route', () => {
    for (const { path } of routes) {
      expect(path).not.toMatch(/resolve|dismiss/);
    }
    expect(routes.map(({ path }) => path).sort()).toEqual(
      ['/', 'stats', ':id', ':id', ':id/assign', ':id/assign'].sort(),
    );
  });

  // Nest matches in declaration order, and SafeRouteParamPipe('id') accepts
  // "stats", so GET stats declared after GET :id would be read as report
  // "stats" and answer 404. The e2e suite checks the same thing over HTTP.
  it('declares GET stats before GET :id', () => {
    const gets = routes.filter(({ method }) => method === RequestMethod.GET);
    expect(gets.map(({ path }) => path)).toEqual(['/', 'stats', ':id']);
    expect(gets.map(({ name }) => name)).toEqual([
      'findAll',
      'queueStats',
      'findOne',
    ]);
  });
});
