import { Controller, Get, Param } from '@nestjs/common';

@Controller('users')
export class UsersController {
    @Get(':username')
    getUserProfile(@Param('username') username: string) {
        return { message: 'Not implemented' };
    }
}
