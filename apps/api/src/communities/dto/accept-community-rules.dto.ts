import { IsInt, Max, Min } from 'class-validator';

export class AcceptCommunityRulesDto {
  /**
   * The rules version the client displayed; it must be the current one. A
   * JSON number: strings and booleans are rejected rather than coerced.
   */
  @IsInt()
  @Min(1)
  @Max(4294967295)
  version!: number;
}
