// Applies the @nestjs/swagger compiler plugin under ts-jest with the options
// from nest-cli.json, so tests see the same OpenAPI metadata as `nest build`.
const { before } = require('@nestjs/swagger/plugin');
const nestCli = require('./nest-cli.json');

const plugin = nestCli.compilerOptions.plugins.find(
  (entry) => entry.name === '@nestjs/swagger',
);

module.exports.name = 'nestjs-swagger-transformer';
module.exports.version = 1;
module.exports.factory = (compiler) => before(plugin.options, compiler.program);
