// 设计系统的光学脚本（packages/design-system/scripts/optics.js）在页面上留下的入口。
interface QuetzalcoatlOpticsApi {
  /** 让 `root` 里带 `data-qz-lit` 的区块随滚动接住光；返回停止监听的函数。 */
  init(root?: ParentNode): () => void;
}

declare var QuetzalcoatlOptics: QuetzalcoatlOpticsApi | undefined;
