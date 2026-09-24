import { Controller, Get, Post, Delete, Param, Query, Body } from '@nestjs/common';

@Controller('communities')
export class CommunitiesController {
    @Get()
    findAll(@Query() query: any) {
        return { message: 'Not implemented' };
    }

    @Post()
    create(@Body() body: any) {
        return { message: 'Not implemented' };
    }

    @Get(':name')
    findOne(@Param('name') name: string) {
        return { message: 'Not implemented' };
    }

    @Post(':name/subscribe')
    subscribe(@Param('name') name: string) {
        return { message: 'Not implemented' };
    }

    @Delete(':name/subscribe')
    unsubscribe(@Param('name') name: string) {
        return { message: 'Not implemented' };
    }
}
