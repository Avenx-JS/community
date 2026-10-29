// Declares no properties on purpose: with the global ValidationPipe's
// forbidNonWhitelisted, any body or query field, including a type or
// community filter, is rejected with 400. "Mark all read" takes no filters.
export class ReadAllNotificationsDto {}
