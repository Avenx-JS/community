import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { UsersModule } from '../users/users.module';
import { AdminReportsController } from './admin-reports.controller';
import { AdminReportsService } from './admin-reports.service';

@Module({
  imports: [AuthModule, DatabaseModule, UsersModule],
  controllers: [AdminReportsController],
  providers: [AdminReportsService],
})
export class AdminModule {}
