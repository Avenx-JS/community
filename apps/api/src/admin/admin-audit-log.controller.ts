import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { RequiresRole } from '../auth/requires-role.decorator';
import { AdminAuditLogService } from './admin-audit-log.service';
import { ListAdminActionsDto } from './dto/list-admin-actions.dto';

// Read-only by design: the audit trail is append-only, so this controller
// exposes no PATCH, PUT or DELETE route. Moderator access is an open policy
// decision; widening it is a change to the role list below.
@Controller('admin/audit-log')
@UseGuards(AuthGuard, AdminGuard)
@RequiresRole('admin')
export class AdminAuditLogController {
  constructor(private readonly auditLogService: AdminAuditLogService) {}

  @Get()
  findAll(@Query() query: ListAdminActionsDto) {
    return this.auditLogService.findAll(query);
  }
}
