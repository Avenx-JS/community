import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  providers: [ReportsService],
  controllers: [ReportsController],
})
export class ReportsModule {}
