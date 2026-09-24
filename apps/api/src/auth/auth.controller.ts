import { Controller, Post, Body } from '@nestjs/common';

@Controller('auth')
export class AuthController {
    @Post('register')
    register(@Body() body: any) {
        return { message: 'Not implemented' };
    }

    @Post('login')
    login(@Body() body: any) {
        return { message: 'Not implemented' };
    }

    @Post('logout')
    logout() {
        return { message: 'Not implemented' };
    }
}
