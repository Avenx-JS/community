import { Controller, Get, Post, Delete, Param, Query, Body } from '@nestjs/common';

@Controller('posts')
export class PostsController {
    @Get()
    findAll(@Query() query: any) {
        return { message: 'Not implemented' };
    }

    @Post()
    create(@Body() body: any) {
        return { message: 'Not implemented' };
    }

    @Get(':id')
    findOne(@Param('id') id: string) {
        return { message: 'Not implemented' };
    }

    @Delete(':id')
    remove(@Param('id') id: string) {
        return { message: 'Not implemented' };
    }

    @Get(':postId/comments')
    getComments(@Param('postId') postId: string) {
        return { message: 'Not implemented' };
    }

    @Post(':postId/comments')
    addComment(@Param('postId') postId: string, @Body() body: any) {
        return { message: 'Not implemented' };
    }
}
