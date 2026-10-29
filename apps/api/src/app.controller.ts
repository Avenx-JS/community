import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { AppService } from './app.service';
import { HealthResponse } from './app.responses';

@ApiTags('health')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: 'Service greeting' })
  @ApiProduces('text/html')
  @ApiOkResponse({ description: 'Plain greeting text.', type: String })
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  @ApiOperation({
    summary: 'Liveness check',
    description: 'The only route exempt from API rate limiting.',
  })
  @ApiOkResponse({ type: HealthResponse })
  getHealth(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
