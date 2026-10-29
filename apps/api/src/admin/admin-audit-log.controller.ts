import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresRole } from '../auth/requires-role.decorator';
import { ApiAuthenticated, ApiErrorResponses } from '../common/openapi';
import { AdminAuditLogService } from './admin-audit-log.service';
import { ADMIN_ONLY } from './admin.openapi';
import { AdminActionListResponse } from './admin.responses';
import { ListAdminActionsDto } from './dto/list-admin-actions.dto';

// Read-only by design: the audit trail is append-only, so this controller
// exposes no PATCH, PUT or DELETE route. Moderator access is an open policy
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
}
