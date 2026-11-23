import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Action, ResourceType } from '@puet/shared';
import type { AuthenticatedRequest } from '../auth/principal';
import { Authorize } from '../authz/authorize.decorator';
import { parse } from '../common/validation';
import {
  backupKeysInput,
  backupVersionInput,
  deviceSigningUpload,
  keysClaim,
  keysQuery,
  keysUpload,
  registerDevice,
  secretInput,
  secretName,
  sendToDevice,
  signaturesUpload,
  syncQuery,
  toDeviceEventType,
  txnId,
} from './e2ee.schemas';
import { E2eeService } from './e2ee.service';

const SELF = { type: ResourceType.SELF } as const;
const DEVICE = { type: ResourceType.DEVICE, idField: 'deviceId' } as const;

/**
 * E2EE key directory for vodozemac clients (Matrix key API shapes).
 * Device-bound calls take the device id in the path; the guard checks that
 * the device is the caller's own and not revoked.
 */
@Controller('e2ee')
export class E2eeController {
  constructor(@Inject(E2eeService) private readonly e2ee: E2eeService) {}

  @Get('whoami')
  @Authorize(Action.DEVICE_MANAGE, SELF)
  whoami(@Req() req: AuthenticatedRequest) {
    return { userId: this.e2ee.mxid(req.principal!.userId) };
  }

  @Post('devices')
  @Authorize(Action.DEVICE_MANAGE, SELF)
  register(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.e2ee.registerDevice(req.principal!, parse(registerDevice, body).label);
  }

  @Get('devices')
  @Authorize(Action.DEVICE_MANAGE, SELF)
  devices(@Req() req: AuthenticatedRequest) {
    return this.e2ee.listDevices(req.principal!);
  }

  @Delete('devices/:deviceId')
  @Authorize(Action.DEVICE_MANAGE, DEVICE)
  revoke(@Req() req: AuthenticatedRequest) {
    return this.e2ee.revokeDevice(req.principal!, req.authz!.resource.id!);
  }

  @Post('devices/:deviceId/keys/upload')
  @HttpCode(200)
  @Authorize(Action.DEVICE_MANAGE, DEVICE)
  upload(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.e2ee.uploadKeys(req.principal!, req.authz!.resource.id!, parse(keysUpload, body));
  }

  @Get('devices/:deviceId/sync')
  @Authorize(Action.DEVICE_MANAGE, DEVICE)
  sync(@Req() req: AuthenticatedRequest, @Query() query: Record<string, unknown>) {
    const { deviceId: _d, ...rest } = query;
    return this.e2ee.sync(req.principal!, req.authz!.resource.id!, parse(syncQuery, rest));
  }

  @Put('devices/:deviceId/sendToDevice/:eventType/:txnId')
  @Authorize(Action.E2EE_KEYS_ACCESS, DEVICE)
  sendToDevice(
    @Req() req: AuthenticatedRequest,
    @Param('eventType') eventType: string,
    @Param('txnId') txn: string,
    @Body() body: unknown,
  ) {
    parse(txnId, txn);
    return this.e2ee.sendToDevice(req.principal!, req.authz!.resource.id!, parse(toDeviceEventType, eventType), parse(sendToDevice, body));
  }

  @Post('keys/query')
  @HttpCode(200)
  @Authorize(Action.E2EE_KEYS_ACCESS, SELF)
  query(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.e2ee.queryKeys(req.principal!, parse(keysQuery, body));
  }

  @Post('keys/claim')
  @HttpCode(200)
  @Authorize(Action.E2EE_KEYS_ACCESS, SELF)
  claim(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.e2ee.claimKeys(req.principal!, parse(keysClaim, body));
  }

  @Post('keys/device_signing/upload')
  @HttpCode(200)
  @Authorize(Action.DEVICE_MANAGE, SELF)
  deviceSigning(@Req() req: AuthenticatedRequest, @Body() body: unknown, @Query('replace') replace?: string) {
    return this.e2ee.uploadDeviceSigning(req.principal!, parse(deviceSigningUpload, body), replace === 'true');
  }

  @Post('keys/signatures/upload')
  @HttpCode(200)
  @Authorize(Action.DEVICE_MANAGE, SELF)
  signatures(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.e2ee.uploadSignatures(req.principal!, parse(signaturesUpload, body));
  }

  @Post('room_keys/version')
  @HttpCode(200)
  @Authorize(Action.DEVICE_MANAGE, SELF)
  createBackup(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.e2ee.createBackupVersion(req.principal!, parse(backupVersionInput, body));
  }

  @Get('room_keys/version')
  @Authorize(Action.DEVICE_MANAGE, SELF)
  backup(@Req() req: AuthenticatedRequest) {
    return this.e2ee.currentBackup(req.principal!);
  }

  @Put('room_keys/keys')
  @Authorize(Action.DEVICE_MANAGE, SELF)
  putKeys(@Req() req: AuthenticatedRequest, @Query('version') version: string, @Body() body: unknown) {
    return this.e2ee.putBackupKeys(req.principal!, String(version ?? ''), parse(backupKeysInput, body));
  }

  @Get('room_keys/keys')
  @Authorize(Action.DEVICE_MANAGE, SELF)
  getKeys(@Req() req: AuthenticatedRequest, @Query('version') version: string) {
    return this.e2ee.getBackupKeys(req.principal!, String(version ?? ''));
  }

  @Put('secrets/:name')
  @Authorize(Action.DEVICE_MANAGE, SELF)
  putSecret(@Req() req: AuthenticatedRequest, @Param('name') name: string, @Body() body: unknown) {
    return this.e2ee.putSecret(req.principal!, parse(secretName, name), parse(secretInput, body).ciphertext);
  }

  @Get('secrets/:name')
  @Authorize(Action.DEVICE_MANAGE, SELF)
  getSecret(@Req() req: AuthenticatedRequest, @Param('name') name: string) {
    return this.e2ee.getSecret(req.principal!, parse(secretName, name));
  }
}
