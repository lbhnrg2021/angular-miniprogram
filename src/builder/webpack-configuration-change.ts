import { BuilderContext } from '@angular-devkit/architect';
import {
  AssetPattern,
  BrowserBuilderOptions,
} from '@angular-devkit/build-angular';
import { Path, getSystemPath, normalize, resolve } from '@angular-devkit/core';
import * as fs from 'fs';
import * as path from 'path';
import { filter } from 'rxjs/operators';
import { Injector } from 'static-injector';
import * as webpack from 'webpack';
import { DefinePlugin } from 'webpack';
import { BootstrapAssetsPlugin } from 'webpack-bootstrap-assets-plugin';
import { BuildPlatform, PlatformType } from './platform/platform';
import { PlatformInfo, getPlatformInfo } from './platform/platform-info';
import { WxPlatformInfo } from './platform/wx-platform-info';
import { DynamicWatchEntryPlugin } from './plugin/dynamic-watch-entry.plugin';
import { ExportWeiXinAssetsPlugin } from './plugin/export-weixin-assets.plugin';
import { WxTransform } from './template-transform-strategy/wx.transform';
import { TS_CONFIG_TOKEN } from './token/project.token';
import { PagePattern } from './type';

type OptimizationOptions = NonNullable<webpack.Configuration['optimization']>;
type OptimizationSplitChunksOptions = Exclude<
  OptimizationOptions['splitChunks'],
  false | undefined
>;
type OptimizationSplitChunksCacheGroup = Exclude<
  NonNullable<OptimizationSplitChunksOptions['cacheGroups']>[''],
  false | string | Function | RegExp
>;

export class WebpackConfigurationChange {
  workspaceRoot!: Path;
  absoluteProjectRoot!: Path;
  absoluteProjectSourceRoot!: Path;
  exportWeiXinAssetsPluginInstance!: ExportWeiXinAssetsPlugin;
  private platformInfo: PlatformInfo;
  private entryList!: PagePattern[];
  injector: Injector;
  constructor(
    private options: BrowserBuilderOptions & {
      pages: AssetPattern[];
      components: AssetPattern[];
      platform: PlatformType;
    },
    private context: BuilderContext,
    private config: webpack.Configuration
  ) {
    this.injector = Injector.create({
      providers: [
        { provide: WxTransform },
        { provide: WxPlatformInfo },
        {
          provide: BuildPlatform,
          useClass: getPlatformInfo(options.platform),
        },
        { provide: ExportWeiXinAssetsPlugin },
        {
          provide: TS_CONFIG_TOKEN,
          useValue: path.resolve(
            this.context.workspaceRoot,
            this.options.tsConfig
          ),
        },
      ],
    });
    this.platformInfo = this.injector.get(BuildPlatform);
    config.output!.globalObject = this.platformInfo.globalObject;
  }

  async change() {
    await this.pageHandle();
    this.exportWeiXinAssetsPlugin();
    this.componentTemplateLoader();
    this.definePlugin();
    this.changeStylesExportSuffix();
  }
  private async pageHandle() {
    this.workspaceRoot = normalize(this.context.workspaceRoot);
    const projectName = this.context.target && this.context.target.project;
    if (!projectName) {
      throw new Error('The builder requires a target.');
    }
    const projectMetadata = await this.context.getProjectMetadata(projectName);
    this.absoluteProjectRoot = normalize(
      getSystemPath(
        resolve(
          this.workspaceRoot,
          normalize((projectMetadata.root as string) || '')
        )
      )
    );
    const relativeSourceRoot = projectMetadata.sourceRoot as string | undefined;
    const absoluteSourceRootPath =
      typeof relativeSourceRoot === 'string'
        ? resolve(this.workspaceRoot, normalize(relativeSourceRoot))
        : undefined;
    if (relativeSourceRoot) {
      this.absoluteProjectSourceRoot = normalize(
        getSystemPath(absoluteSourceRootPath!)
      )!;
    }
    const dynamicWatchEntryInstance = new DynamicWatchEntryPlugin({
      pages: this.options.pages,
      components: this.options.components,
      workspaceRoot: this.workspaceRoot,
      absoluteProjectRoot: this.absoluteProjectRoot,
      context: this.context,
      absoluteProjectSourceRoot: this.absoluteProjectSourceRoot,
      config: this.config,
    });
    dynamicWatchEntryInstance.entryPattern$
      .pipe(filter((item) => !!item))
      .subscribe((result) => {
        this.entryList = [...result!.pageList, ...result!.componentList];
        this.exportWeiXinAssetsPluginInstance.setEntry(
          result!.pageList,
          result!.componentList
        );
      });
    this.config.plugins?.push(dynamicWatchEntryInstance);
    // 出口
    const oldFileName = this.config.output!.filename as Function;
    this.config.output!.filename = (chunkData) => {
      const page = this.entryList.find(
        (item) => item.entryName === chunkData.chunk!.name
      );
      if (page) {
        return page.outputWXS;
      }
      return oldFileName(chunkData);
    };
    // 共享依赖
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldChunks = (this.config.optimization!.splitChunks as any).cacheGroups
      .defaultVendors.chunks;
    (
      (
        this.config.optimization!
          .splitChunks! as unknown as OptimizationSplitChunksOptions
      ).cacheGroups!.defaultVendors as OptimizationSplitChunksCacheGroup
    ).chunks = (chunk) => {
      if (this.entryList.find((item) => item.entryName === chunk.name)) {
        return true;
      }
      return oldChunks(chunk);
    };
    ((this.config.optimization!.splitChunks as OptimizationSplitChunksOptions)
      .cacheGroups!['moduleChunks'] as OptimizationSplitChunksCacheGroup) = {
      test: (module: webpack.NormalModule) => {
        const name = module.nameForCondition();
        return (
          name && name.endsWith('.ts') && !/[\\/]node_modules[\\/]/.test(name)
        );
      },
      minChunks: 2,
      minSize: 0,
      name: 'module-chunk',
      chunks: 'all',
    };
    // 出口保留必要加载
    const assetsPlugin = new BootstrapAssetsPlugin();
    assetsPlugin.hooks.removeChunk.tap('pageHandle', (chunk) => {
      if (
        this.entryList.some((page) => page.entryName === chunk.name) ||
        chunk.name === 'styles'
      ) {
        return true;
      }
      return false;
    });
    assetsPlugin.hooks.emitAssets.tap('pageHandle', (object, json) => {
      return {
        'app.js':
          fs
            .readFileSync(path.resolve(__dirname, './template/app-template.js'))
            .toString() +
          json.scripts.map((item) => `require('./${item.src}')`).join(';'),
      };
    });
    this.config.plugins!.push(assetsPlugin);
  }
  exportWeiXinAssetsPlugin() {
    this.exportWeiXinAssetsPluginInstance = this.injector.get(
      ExportWeiXinAssetsPlugin
    );
    this.config.plugins!.unshift(this.exportWeiXinAssetsPluginInstance);
  }

  private componentTemplateLoader() {
    this.config.module!.rules!.unshift({
      test: /\.ts$/,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      loader: (require as any).resolve(
        path.join(__dirname, './loader/component-template.loader')
      ),
    });
  }
  private definePlugin() {
    const defineObject: Record<string, string> = {
      global: `${this.platformInfo.globalObject}.__global`,
      window: `${this.platformInfo.globalVariablePrefix}`,
      Zone: `${this.platformInfo.globalVariablePrefix}.Zone`,
      setTimeout: `${this.platformInfo.globalVariablePrefix}.setTimeout`,
      clearTimeout: `${this.platformInfo.globalVariablePrefix}.clearTimeout`,
      setInterval: `${this.platformInfo.globalVariablePrefix}.setInterval`,
      clearInterval: `${this.platformInfo.globalVariablePrefix}.clearInterval`,
      setImmediate: `${this.platformInfo.globalVariablePrefix}.setImmediate`,
      clearImmediate: `${this.platformInfo.globalVariablePrefix}.clearImmediate`,
      Promise: `${this.platformInfo.globalVariablePrefix}.Promise`,
      Reflect: `${this.platformInfo.globalVariablePrefix}.Reflect`,
      requestAnimationFrame: `${this.platformInfo.globalVariablePrefix}.requestAnimationFrame`,
      cancelAnimationFrame: `${this.platformInfo.globalVariablePrefix}.cancelAnimationFrame`,
      performance: `${this.platformInfo.globalVariablePrefix}.performance`,
      navigator: `${this.platformInfo.globalVariablePrefix}.navigator`,
    };
    if (this.config.mode === 'development') {
      defineObject['ngDevMode'] = `${this.platformInfo.globalObject}.ngDevMode`;
    }
    this.config.plugins!.push(new DefinePlugin(defineObject));
  }
  private changeStylesExportSuffix() {
    const index = this.config.plugins?.findIndex(
      (plugin) =>
        Object.getPrototypeOf(plugin).constructor.name ===
        'MiniCssExtractPlugin'
    );
    if (typeof index === 'number') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pluginInstance = this.config.plugins![index] as any;
      const pluginPrototype = Object.getPrototypeOf(pluginInstance);
      this.config.plugins?.splice(
        index,
        1,
        new pluginPrototype.constructor({
          filename: (pluginInstance.options.filename as string).replace(
            /\.css$/,
            '.wxss'
          ),
        })
      );
    }
  }
}
