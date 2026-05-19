import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CompanyController } from './company.controller';
import { CompanyService } from './company.service';

@Module({
  imports: [AuthModule],
  controllers: [CompanyController],
  providers: [CompanyService],
})
export class SettingsModule {}
