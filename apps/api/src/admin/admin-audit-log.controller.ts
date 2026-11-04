import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresRole } from '../auth/requires-role.decorator';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ApiRouteParam,
} from '../common/openapi';
import { SafeRouteParamPipe } from '../common/safe-route-param.pipe';
import { AdminAuditLogService } from './admin-audit-log.service';
import { ADMIN_ONLY } from './admin.openapi';
import {
  AdminActionItemResponse,
  AdminActionListResponse,
} from './admin.responses';
import { ListAdminActionsDto } from './dto/list-admin-actions.dto';

// Read-only by design: the audit trail is append-only and its entries are
// immutable, so this controller exposes no PATCH, PUT or DELETE route, on the
// collection or on a single entry. Moderator access is an open policy
// decision; widening it is a change to the role list below.
@ApiTags('admin: audit log')
@Controller('admin/audit-log')
@UseGuards(AuthGuard, AdminGuard)
@RequiresRole('admin')
export class AdminAuditLogController {
  constructor(private readonly auditLogService: AdminAuditLogService) {}

  @Get()
  @ApiOperation({
    summary: 'List administrative actions',
    description: 'The append-only audit trail; there is no write route.',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiOkResponse({ type: AdminActionListResponse })
  @ApiErrorResponses({ 400: 'Invalid query parameters.' })
  findAll(@Query() query: ListAdminActionsDto) {
    return this.auditLogService.findAll(query);
  }

  // Same item shape as the list, with no target resolution: the target may
  // have been deleted, and the entry must still render.
  @Get(':id')
  @ApiOperation({
    summary: 'Get an administrative action',
    description:
      'The same item as in the list. The target is not resolved, and the ' +
      'entry is immutable; there is no update or delete route.',
  })
  @ApiAuthenticated(ADMIN_ONLY)
  @ApiRouteParam('id', 'id', 'Audit entry ID.')
  @ApiOkResponse({ type: AdminActionItemResponse })
  @ApiErrorResponses({
    400: 'Invalid audit entry ID.',
    404: 'Audit entry not found.',
  })
  findOne(@Param('id', new SafeRouteParamPipe('id')) id: string) {
    return this.auditLogService.findOne(id);
  }
}
