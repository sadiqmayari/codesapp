import { IsString, MinLength } from 'class-validator';

export class Step4WabaPhoneDto {
  @IsString()
  @MinLength(1)
  wabaId!: string;

  @IsString()
  @MinLength(1)
  phoneNumberId!: string;
}
