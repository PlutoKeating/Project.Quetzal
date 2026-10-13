# Training-Free Group Relative Policy Optimization

> 本文由 PDF 自动提取，尚未逐项人工校对。每页附完整原图，用于核对图片、图表、公式与布局。


## PDF 第 1 页

**<u>Training-Free GRPO</u>**

## **Training-Free Group Relative Policy Optimization**


**Youtu-Agent Team** <sup>_∗_</sup>


Recent advances in Large Language Model (LLM) agents have demonstrated their promising general
capabilities. However, their performance in specialized real-world domains often degrades due
to challenges in effectively integrating external tools and specific prompting strategies. While
methods like agentic reinforcement learning have been proposed to address this, they typically
rely on costly parameter updates, for example, through a process that uses Supervised Fine-Tuning
(SFT) followed by a Reinforcement Learning (RL) phase with Group Relative Policy Optimization
(GRPO) to alter the output distribution. However, we argue that LLMs can achieve a similar effect
on the output distribution by learning experiential knowledge as a token prior, which is a far more
lightweight approach that not only addresses practical data scarcity but also avoids the common issue
of overfitting. To this end, we propose Training-Free Group Relative Policy Optimization (TrainingFree GRPO), a cost-effective solution that enhances LLM agent performance without any parameter
updates. Our method leverages the group relative semantic advantage instead of numerical ones
within each group of rollouts, iteratively distilling high-quality experiential knowledge during
multi-epoch learning on a minimal ground-truth data. Such knowledge serves as the learned token
prior, which is seamlessly integrated during LLM API calls to guide model behavior. Experiments
on mathematical reasoning and web searching tasks demonstrate that Training-Free GRPO, when
applied to DeepSeek-V3.1-Terminus, significantly improves out-of-domain performance. With just a
few dozen training samples, Training-Free GRPO outperforms fine-tuned small LLMs with marginal
training data and cost.


**Date:** October 9, 2025
**Correspondence:** `t` ristanli@tencent.com
**Code:** `[https://github.com/TencentCloudADP/youtu-agent/tree/training_free_GRPO](https://github.com/TencentCloudADP/youtu-agent/tree/training_free_GRPO)`


**Figure 1.** Applying Training-Free GRPO on both prompting (without tools) and ReAct [1] (with tools) achieve improved
Mean@32 on AIME benchmarks [2] with DeepSeek-V3.1-Terminus [3]. It consumes significantly fewer training data and
lower costs on the 671B LLM than fine-tuning a 32B model [4], serving as a cost-effective alternative to RL methods.


*Full author list in contributions.


1



![](assets/figures/2510.08191-0-0.png)

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 1 页完整原图](assets/pages/page-001.png)

</details>


## PDF 第 2 页

**<u>Training-Free GRPO</u>**

### **1 Introduction**


Large Language Models (LLMs) are emerging as powerful general-purpose agents capable of interacting
with complex, real-world environments. They have shown remarkable capabilities across a wide range
of tasks, including complex problem-solving [4, 5, 6], advanced web research [7, 8, 9, 10], code generation
and debugging [11, 12], and proficient computer use [13, 14, 15]. Despite their impressive capabilities,
LLM agents often underperform in specialized, real-world domains. These scenarios typically demand the
integration of external tools (e.g., calculators, APIs, databases), along with domain-specific task definitions
and prompting strategies. Deploying a general-purpose agent out-of-the-box in such settings often results
in suboptimal performance due to limited familiarity with domain-specific requirements or insufficient
exposure to necessary tools.


To bridge this gap, agentic training has emerged as a promising strategy to facilitate the adaptation of LLM
agents to specific domains and their associated tools [4, 7, 8, 16]. Recent advancements in agentic reinforcement learning (Agentic RL) approaches have employed Group Relative Policy Optimization (GRPO) [17]
and its variants [18, 19, 20] to align model behaviors in the parameter space. Although these methods
effectively enhance task-specific capabilities, their reliance on tuning LLM parameters poses several practical
challenges:


- **Computational Cost:** Even for smaller models, fine-tuning demands substantial computational resources,
making it both costly and environmentally unsustainable. For larger models, the costs become prohibitive.
Furthermore, fine-tuned models require dedicated deployment and are often limited to specific applications, rendering them inefficient for low-frequency use cases compared to more versatile general-purpose
models.


- **Poor** **Generalization:** Models optimized via parameter tuning often suffer from unsatisfactory crossdomain generalization, limiting their applicability to narrow tasks. Consequently, multiple specialized
models must be deployed to handle a comprehensive set of tasks, significantly increasing system complexity and maintenance overhead.


- **Data Scarcity:** Fine-tuning LLMs typically necessitates large volumes of high-quality, carefully annotated
data, which are often scarce and prohibitively expensive to obtain in specialized domains. Additionally,
with limited samples, models are highly susceptible to overfitting, leading to poor generalization.


- **Diminishing Returns:** The prohibitive training costs usually compel existing approaches to fine-tune
smaller LLMs with fewer than 32 billion parameters, due to resource constraints rather than optimal
design choices. While larger models would be preferred, the computational expense of fine-tuning
necessitates this compromise. Paradoxically, API-based or open-source larger LLMs often deliver better
cost-performance ratios through scalability and continuous model updates. However, these generalpurpose models underperform in specialized domains where fine-tuning is necessary, creating a costperformance dilemma.


Such limitations inherent in parameter tuning motivate a fundamental research question: _Is applying RL in_
_parametric space the only viable approach?_ _Can we enhance LLM agent performance in a non-parametric way with_
_lower data and computational costs?_


We answer this question affirmatively by proposing **Training-Free Group Relative Policy Optimization**
**(Training-Free GRPO)**, a novel and efficient method that improves LLM agent behavior in a manner similar
to vanilla GRPO, while preserving the original model parameters unchanged. Our approach is motivated by
the insight that LLMs already possess the fundamental capability to adapt to new scenarios, requiring only
minimal practice through limited samples to achieve strong performance. Thus, instead of adapting their
output distribution through parameter tuning, in-context learning [21] that leverages a lightweight _token_
_prior_ can also encapsulate experiential knowledge learned from a minimal training dataset.


2

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 2 页完整原图](assets/pages/page-002.png)

</details>


## PDF 第 3 页

**<u>Training-Free GRPO</u>**


Training-Free GRPO retains the multi-epoch learning mechanism of vanilla GRPO. In each epoch, multiple
outputs are generated to deliver a group of rollouts for every query, which helps to explore the policy
space and evaluate potential strategies. While vanilla GRPO relies on gradient-based parameter updates
to iteratively improve policy performance, Training-Free GRPO eliminates this requirement by employing
inference-only operations using LLMs. At each optimization step, rather than calculating a numerical
advantage for gradient ascent within each group of rollouts, our method leverages LLMs to introspect on
each group and distill a semantic advantage. Such advantage refines external experiential knowledge and
guide policy outputs based on evolving contextual priors, thereby achieving policy optimization effects
without modifying any model parameters.


By evaluating challenging mathematical reasoning and interactive web searching tasks, we demonstrate
that our method significantly enhances the performance of frozen policy models such as DeepSeek-V3.1Terminus [3] with only dozens of training samples. It surpasses fine-tuned 32B models in performance
while requiring only a fraction of the computational resources, offering a simple and much more efficient
alternative to traditional fine-tuning techniques.


Our principal contributions are threefold:


- **A New Training-Free RL Paradigm:** We introduce Training-Free GRPO, which shifts policy optimization
from the parameter space to the context space by leveraging evolving experiential knowledge as token
priors without gradient updates.


- **Semantic** **Group** **Advantage:** We replace numerical group advantage in vanilla GRPO with _semantic_
_group advantage_, enabling LLMs to introspect their own rollouts and continuously updating experiential
knowledge at multiple optimization steps.


- **Data and Computational Efficiency:** Experiments confirm that Training-Free GRPO effectively enhances
the performance of a frozen policy with minimal training samples, offering a practical and cost-effective
alternative across different domains.


- **Superior Generalization:** By leaving model parameters frozen and plugging in different token priors,
our approach fully preserves the generalization power, eliminating the cost and complexity of deploying
multiple fine-tuned specialists.

### **2 Training-Free GRPO**


In this section, we introduce our Training-Free GRPO, a method designed to replicate the alignment benefits
of the GRPO algorithm without performing any gradient-based updates to the policy model’s parameters.


**Vanilla GRPO.** As shown in Figure 2, the vanilla GRPO procedure operates by first generating a group of

_G_ outputs _{o_ 1, _o_ 2, . . ., _oG}_ for a given query _q_ using the current policy LLM _πθ_, i.e., _πθ_ ( _oi_ _|_ _q_ ). Each output
_oi_ is then independently scored with a reward model _R_ . Subsequently, with rewards **r** = _{r_ 1, . . ., _rG}_, it
calculates a group-relative advantage _A_ <sup>ˆ</sup> _i_ = <sup>_<u>ri−</u>_</sup> std <sup><u>mean</u></sup> ( **r** ) <sup><u>(</u></sup> <sup>**<u>r</u>**</sup> <sup><u>)</u></sup> for each output _oi_ . By combining a KL-divergence

penalty against a reference model, it constructs a PPO-clipped objective function _J_ GRPO( _θ_ ), which is then
maximized to update the LLM parameters _θ_ .


Training-Free GRPO repurposes the core logic of this group-based relative evaluation but translates it into
a non-parametric, inference-time process. Instead of updating the parameters _θ_, we leave _θ_ permanently
frozen and maintain an external _experiential knowledge E_, which is initialized to ∅.


3

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 3 页完整原图](assets/pages/page-003.png)

</details>


## PDF 第 4 页

**<u>Training-Free GRPO</u>**


**Figure 2.** Comparison of vanilla GRPO and Training-Free GRPO.


**Rollout and Reward.** As shown in Figure 2, our rollout and reward process mirrors that of GRPO exactly.
Given a query _q_, we perform a parallel rollout to generate a group of _G_ outputs _{o_ 1, _o_ 2, . . ., _oG}_ using the
LLM. Notably, while GRPO uses the current trainable policy _πθ_, our policy conditions on the experiential
knowledge, _πθ_ ( _oi|q_, _E_ ). Identical to the standard GRPO setup, we score each output _oi_ by the reward model
_R_ to obtain a scalar reward _ri_ = _R_ ( _q_, _oi_ ).


**Group** **Advantage** **Computation.** To provide an optimization direction for policy parameters, vanilla
GRPO computes a numerical advantage _A_ <sup>ˆ</sup> _i_ that quantifies each output _oi_ ’s relative quality within its group.
Similarly, Training-Free GRPO performs an analogous comparison within each group but produces a _group_
_relative semantic advantage_ in the form of natural language experience, as shown in Figure 3. Since _A_ <sup>ˆ</sup> _i_ = 0
when all _G_ outputs receive identical rewards (i.e., std( **r** ) = 0) in vanilla GRPO, we generate such semantic
advantages only for groups with both clear winners and losers. Specifically, for each output _oi_, we first ask
the same LLM _M_ to provide a corresponding summary _si_ = _M_ ( _p_ summary, _q_, _oi_ ) separately, where _p_ summary
is a prompt template that incorporates the query _q_ and output _oi_ to form a structured summarization request.
Given the summaries _{s_ 1, _s_ 2, . . ., _sG}_ and the current experiential knowledge _E_, the LLM _M_ articulates the
reasons for the relative success or failure of the outputs, followed by extracting a concise natural language
experience _A_ text = _M_ ( _p_ extract, _q_, _si_, _E_ ), where _p_ extract is another prompt template for experience extraction.
This natural language experience _A_ text serves as our semantic advantage, functionally equivalent to vanilla
GRPO’s _A_ <sup>ˆ</sup> _i_, encoding the critical experiential knowledge of what actions lead to high rewards.


**Optimization.** Whereas vanilla GRPO updates its model parameters _θ_ via gradient ascent on _J_ GRPO( _θ_ )
computed by all advantages in a single batch, we update our experience library _E_ using all semantic
advantages _A_ text from the current batch. Specifically, given the existing experiences library _E_, we prompt the
LLM to generate a list of operations based on all these _A_ text, where each operation could be:


- _Add:_ Directly append the experience described in _A_ text to the experience library _E_ .


- _Delete:_ Based on _A_ text, remove a low-quality experience from the experience library _E_ .


- _Modify:_ Refine or improve an existing experience in the experience library _E_ based on insights from _A_ text.


- _Keep:_ The experience library _E_ remains unchanged.


4



![](assets/figures/2510.08191-3-0.png)

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 4 页完整原图](assets/pages/page-004.png)

</details>


## PDF 第 5 页

**<u>Training-Free GRPO</u>**


**Figure 3.** Example of a Training-Free GRPO learning step.


After updating the experience library _E_, the conditioned policy _πθ_ ( _y|q_, _E_ ) produces a shifted output distribution in subsequent batches or epochs. This mirrors the effect of a GRPO policy update by steering the
model towards higher-reward outputs, but achieves this by altering the context rather than the model’s
fundamental parameters. The frozen base model _πθ_ acts as a strong prior, ensuring output coherence and
providing a built-in stability analogous to the KL-divergence constraint in GRPO that prevents the policy
from deviating excessively from _π_ ref.

### **3 Evalution**


To compare Training-Free GRPO with competitive baselines, we conduct comprehensive experiments on
both mathematical reasoning and web searching benchmarks.


#### 3.1 Mathematical Reasoning


**Benchmarks.** We conduct our evaluation on the challenging AIME24 and AIME25 benchmarks [2], which
are representative of complex, out-of-domain mathematical reasoning challenges. To ensure robust and
statistically reliable results, we evaluate each problem with 32 independent runs and report the average
Pass@1 score, which we denote as Mean@32.


5



![](assets/figures/2510.08191-4-0.png)

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 5 页完整原图](assets/pages/page-005.png)

</details>


## PDF 第 6 页

**<u>Training-Free GRPO</u>**


**Table 1.** Mean@32 on AIME 2024 and AIME 2025 benchmarks (%).


**Method** **Learning Cost** **Training Set** **Model** **Tool** **AIME24** **AIME25**


Direct - - _DeepSeek-V3.1-Terminus_ - 68.6 52.9
+ Training-Free GRPO _≈_ $8 DAPO-100 _DeepSeek-V3.1-Terminus_ - **72.6** ( _↑_ 4.0) **54.0** ( _↑_ 1.1)


ReAct [1] - - _DeepSeek-V3.1-Terminus_ CI 80.0 67.9
+ Training-Free GRPO _≈_ $18 DAPO-100 _DeepSeek-V3.1-Terminus_ CI **82.7** ( _↑_ 2.7) **73.3** ( _↑_ 5.4)


ReAct [1] - - _DeepSeek-V3.2-Exp_ CI 71.0 61.8
+ Training-Free GRPO _≈_ $8 DAPO-100 _DeepSeek-V3.2-Exp_ CI **73.1** ( _↑_ 2.1) **63.2** ( _↑_ 1.4)



90


85


80


75


70


65


60



<u>Train</u> <u>AIME24</u> <u>AIME25</u>



6.0


5.5


5.0


4.5


4.0


3.5


3.0



<u>Train</u> <u>AIME24</u> <u>AIME25</u>



![](assets/figures/2510.08191-5-0.png)

![](assets/figures/2510.08191-5-1.png)

and 67.9% on AIME25. Critically, applying Training-Free GRPO to the frozen DeepSeek-V3.1-Terminus
elevates its performance significantly, reaching 82.7% on AIME24 and 73.3% on AIME25. This represents a
substantial absolute gain of +2.7% and +5.4%, respectively, which is achieved with only 100 out-of-domain
training examples and zero gradient updates. This performance surpasses various state-of-the-art RL
methods like ReTool [4] and AFM [16] trained on 32B LLMs (see Table 3), which typically require thousands
of training examples and incur costs exceeding $10, 000. In contrast, Training-Free GRPO utilizes only
100 data points with an approximate cost of $18. Such outcome suggests that in real-world applications,
guiding a powerful but frozen model through context-space optimization is more effective and efficient than
exhaustively fine-tuning a less capable model in parameter space. For quantitative evaluation and learned
experiences of Training-Free GRPO, please refer to Appendices A and C, respectively.


**Learning Dynamics.** As shown in Figure 4, during the 3-step learning process, we observe a steady and
significant improvement in Mean@5 on the training set. Concurrently, the Mean@32 performance on both


6

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 6 页完整原图](assets/pages/page-006.png)

</details>


## PDF 第 7 页

**<u>Training-Free GRPO</u>**


**Table 2.** Ablation study on DeepSeek-V3.1-Terminus (Mean@32, %).


**Method** **Training Set** **AIME24** **AIME25**


ReAct [1]     - 80.0 67.9
ReAct [1] + Directly Generated Experiences     - 79.8 67.3
ReAct [1] + Training-Free GRPO (w/o ground truths) DAPO-100 80.7 68.9
ReAct [1] + Training-Free GRPO (w/o group computation) DAPO-100 80.4 69.3
ReAct [1] + Training-Free GRPO DAPO-100 **82.7** **73.3**


**Table 3.** Mean@32 with smaller LLMs on AIME 2024 and AIME 2025 benchmarks (%).


**Method** **Learning Cost** **Model** **Tool** **AIME24** **AIME25**


ReAct [1]     - _Qwen2.5-32B-Instruct_ CI 29.6 23.1
ZeroTIR [5] _≈_ $20, 000 _Qwen2.5-32B-Instruct_ CI 56.7 33.3
SimpleTIR [6] _≈_ $20, 000 _Qwen2.5-32B-Instruct_ CI 59.9 49.2
ReTool [4] _≈_ $10, 000 _Qwen2.5-32B-Instruct_ CI 67.0 49.3
AFM [16] _≈_ $10, 000 _Qwen2.5-32B-Instruct_ CI 66.7 59.8


ReAct [1]     - _Qwen3-32B (Non-Thinking)_ CI 29.1 19.5
+ Training-Free GRPO _≈_ $4 _Qwen3-32B (Non-Thinking)_ CI 33.5 ( _↑_ 4.4) 25.4 ( _↑_ 5.9)


ReAct [1]     - _Qwen2.5-72B-Instruct_ CI 13.5 9.6
+ Training-Free GRPO _≈_ $3 _Qwen2.5-72B-Instruct_ CI 14.9 ( _↑_ 1.4) 11.4 ( _↑_ 1.8)


ReAct [1]     - _DeepSeek-V3.1-Terminus_ CI 80.0 67.9
+ Training-Free GRPO _≈_ $18 _DeepSeek-V3.1-Terminus_ CI 82.7 ( _↑_ 2.7) 73.3 ( _↑_ 5.4)


AIME24 and AIME25 also improves with each step, demonstrating that the learned experiences from only
100 problems generalize effectively and the necessity of multi-step learning. Also, the average number of
tool calls decreases during both training and out-of-domain evaluation on AIME benchmarks. This suggests
that Training-Free GRPO not only encourages correct reasoning and action, but also teaches the agent to
use tools more efficiently and judiciously. The learned experiential knowledge helps the agent to discover
some shortcuts and avoid erroneous or redundant tool calls, validating the effectiveness of our semantic
advantage guided optimization.


**Effectiveness of Learned Experiences.** In Table 2, we also include the ReAct enhanced with the experiences
directly generated by DeepSeek-V3.1-Terminus, matching the quantity learned from Training-Free GRPO.
However, such directly generated experiences fail to improve the performance, highlighting the effectiveness
of learned experiential knowledge from Training-Free GRPO.


**Robustness to Reward Signal.** Table 2 also presents a variant of Training-Free GRPO, where the ground
truth answers are not provided during learning process. In such cases, the semantic advantage is directly
obtained by comparing the rollouts within each group, where the LLM can only rely on implicit majority
voting, self-discrimination and self-reflection to optimize the experiences. Although it does not surpass the
default version with ground truths, Training-Free GRPO still achieves an impressive results of 80.7% on
AIME24 and 68.9% on AIME25. It shows the robustness and applicability to domains where ground truths
are scarce or unavailable, further broadening its practical utility.


**Removing Group Computation.** We also remove the group computation by setting the group size of 1 in
Training-Free GRPO, where the LLM can only distill semantic advantage from the single rollout of each
query. The results in Table 2 show that it significantly harm the performance comparing with the default
group size of 5. It confirms the necessity of group relative computation, which enables the LLM to compare
different trajectories within each group for better semantic advantage and experience optimization.


7

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 7 页完整原图](assets/pages/page-007.png)

</details>


## PDF 第 8 页

**<u>Training-Free GRPO</u>**


**Table 4.** Pass@1 on WebWalkerQA (%).


**Method** **Training Set** **Model** **pass@1**


ReAct [1]    - _DeepSeek-V3.1-Terminus_ 63.2
+ Training-Free GRPO AFM-100 _DeepSeek-V3.1-Terminus_ **67.8** ( _↑_ 4.6)


**Table 5.** Ablation results on WebWalkerQA subset (%).


**Method** **Training Set** **Model** **pass@1** **pass@3**


ReAct [1]  - _QwQ-32B_ 27.5 43.1
ReAct [1] + Training-Free GRPO AFM-100 _QwQ-32B_ 25.5 45.1


ReAct [1]  - _DeepSeek-V3.1-Terminus_ 66.7 74.5
ReAct [1] + Directly Generated Experiences AFM-100 _DeepSeek-V3.1-Terminus_ 64.7 76.5
ReAct [1] + Training-Free GRPO (w/o ground truths) AFM-100 _DeepSeek-V3.1-Terminus_ 66.7 78.4
ReAct [1] + Training-Free GRPO AFM-100 _DeepSeek-V3.1-Terminus_ **68.6** **78.4**


**Applicability to Different Model Sizes.** By applying Training-Free GRPO on smaller LLMs, specifically
Qwen3-32B [22] and Qwen2.5-72B-Instruct [23] with DAPO-100 dataset, we observe consistent improvements
on the out-of-domain AIME benchmarks in Table 3. Training-Free GRPO requires significantly fewer data
and much lower learning cost, contrasting sharply with recent RL methods like ZeroTIR [5], SimpleTIR [6],
ReTool [4], and AFM [16], which often necessitate thousands of data points and substantial computational
resources for parameter tuning. Furthermore, powered by larger models like DeepSeek-V3.1-Terminus, our
approach achieves much higher Mean@32 on AIME benchmarks than all RL-trained models, while only
incurring about $18 for the learning process.


#### 3.2 Web Searching


In this section, we evaluate the effectiveness of Training-Free GRPO in addressing web searching tasks by
leveraging minimal experiential data to enhance agent behavior.


**Datasets.** For training, we constructed a minimal training set by randomly sampling 100 queries from the
AFM (Chain-of-Agents) web interaction RL dataset [16], denoted as AFM-100. AFM provides high-quality,
multi-turn interactions between agents and web environments, collected via reinforcement learning in
realistic browsing scenarios. For evaluation, we employ WebWalkerQA benchmark [24], a widely-used
dataset for assessing web agent performance. Its tasks require understanding both natural language
instructions and complex web page structures, making it a rigorous evaluation framework for generalist
agents.


**Methods.** Our proposed Training-Free GRPO is applied to DeepSeek-V3.1-Terminus without any gradientbased updates. We perform 3 epochs of training-free optimization with a group size of _G_ = 3. The
temperature settings follow those used in prior mathematical experiments.


**Main Results.** We evaluate the effectiveness of our proposed Training-Free GRPO method on the WebWalkerQA benchmark. As shown in Table 4, our method achieves a pass@1 score of 67.8% using DeepSeek-V3.1Terminus, a significant improvement over the baseline of 63.2%. This result indicates that our approach
effectively steers model behavior by leveraging learned experiential knowledge, surpassing the capabilities
of static prompting ReAct strategy.


**Ablation.** We conduct ablation studies on a stratified random sample of 51 instances from the WebWalkerQA


8

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 8 页完整原图](assets/pages/page-008.png)

</details>


## PDF 第 9 页

**<u>Training-Free GRPO</u>**


**Table 6.** Cross-domain transferability (Averaged pass@1, %).


**Math Reasoning** **Web Searching**
**Method** **Learned Domain**

<u>AIME24</u> <u>AIME25</u> <u>WebWalker</u>


<u>ReAct [1]</u> _(Qwen2.5-32B-Instruct)_ <u>-</u> <u>29.6</u> <u>23.1</u> <u>31.9</u>


ReTool [4] _(Qwen2.5-32B-Instruct)_ Math 67.0 49.3 18.3
MiroThinker [10] _(Qwen3-32B)_ Web 43.5 36.8 53.6
Training-Free GRPO _(DeepSeek-V3.1-Terminus)_ Math / Web **82.7** **73.3** **67.8**


test set, where the sampling is proportionally stratified by difficulty level to ensure balanced representation across different levels of complexity. All ablated models are evaluated after 2 epochs of experience
optimization. The results are summarized in Table 5.


Using directly generated experiences slightly degrades over ReAct (64.7% vs. 66.7% pass@1), confirming that
mere in-context examples without proper optimization may not yield gains. Training-Free GRPO without
ground truth maintains the same pass@1 as ReAct (66.7%) but improves pass@3 to 78.4%, demonstrating
that relative reward evaluation can enhance consistency even without ground truth. The full Training-Free
GRPO achieves the best performance (68.6% pass@1 and 78.4% pass@3), highlighting the importance of
combining ground truth guidance with semantic advantage and experience optimization.


Applying Training-Free GRPO to QwQ-32B [25] yields only 25.5% pass@1, significantly lower than the 66.7%
achieved with DeepSeek-V3.1-Terminus, and even under performing its own ReAct baseline (27.5%). This
may suggest that the effectiveness of our method is dependent on the underlying model’s reasoning and
tool-use capabilities in complex tool use scenarios, indicating that model capability is a prerequisite for
effective experience-based optimization.

### **4 Comparing RL Learning on Context Space and Parameter Space**


#### 4.1 Cross-domain Transfer Analysis


A critical strength of Training-Free GRPO lies in its ability to achieve strong performance across diverse
domains without suffering from the domain specialization trade-off observed in parameter-tuned methods.
As demonstrated in Table 6, we observe the unsatisfactory performance when domain-specialized models
are transferred to different domains. For instance, ReTool [4] specifically trained on mathematical reasoning
tasks, achieves competitive performance on AIME24 and AIME25 within its specialized domain. However,
when transferred to web searching tasks on WebWalker, its performance drops dramatically to only 18.3%,
which is much lower than ReAct [1] without fine-tuning. Similarly, though optimized for web interactions,
MiroThinker [10] significantly underperforms ReTool that is trained in the math domain on the AIME benchmarks. Such phenomenon highlights that parameter-based specialization narrows the model’s capabilities to
excel in the training domain at the expense of generalizability. In contrast, Training-Free GRPO applied to
the frozen LLM achieves state-of-the-art performance in both domains simultaneously by simply plugging in
domain-specific learned experiences. Such cross-domain robustness makes Training-Free GRPO particularly
valuable for real-world applications where agents must operate in multifaceted environments with diverse
requirements.


9

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 9 页完整原图](assets/pages/page-009.png)

</details>


## PDF 第 10 页

**<u>Training-Free GRPO</u>**


#### 4.2 Computational Costs


As shown in Figure 1, we further analyze the economic benefits of Training-Free GRPO by comparing its
computational costs with a vanilla RL training approach, specifically ReTool [4], on mathematical problemsolving tasks. This comparison highlights the practical benefits of our method in scenarios characterized by
limited data, constrained budgets, or volatile inference demand.


**Training Cost.** By replicating the training process of ReTool [4] on Qwen2.5-32B-Instruct [23], we find that
it requires approximately 20,000 _×_ GPU hours with the rental price of $0.5 per GPU hour, resulting in
the total training expense amounts to roughly $10,000. In contrast, Training-Free GRPO, when applied to
DeepSeek-V3.1-Terminus, achieves superior performance on the AIME benchmarks (Table 3) while requiring
only minimal costs. It requires only 3 training steps over 100 samples completed within 6 hours, which
consumes 38M input tokens and 6.6M output tokens, amounting to a total cost of approximately $18 based
on the official DeepSeek AI pricing <sup>1</sup> . The drastic reduction in training cost by over two orders of magnitude
makes our approach especially cost-effective.


**Inference Cost.** Deploying a trained model like ReTool-32B entails significant fixed infrastructure costs. In a
typical serving setup with 4 _×_ GPUs at the price of $0.5 per GPU-hour, vLLM-based batching requests can
process about 400 problems per hour from the AIME benchmarks. The inference cost per problem averages
$0.005. While this per-instance cost is relatively low, it presupposes continuous GPU availability, which
becomes inefficient under fluctuating or low request volumes. In contrast, Training-Free GRPO incurs a
token-based cost. On average, each request consumes 60K input tokens and 8K output tokens, totaling
about $0.02 per problem with cache hit pricing for reused contexts. Although per-query inference with a
large API-based model is more expensive than with a dedicated small model, many real-world applications,
particularly specialized or low-traffic services, experience irregular and modest usage patterns. In such cases,
maintaining a dedicated GPU cluster is economically unjustifiable. By leveraging the shared, on-demand
infrastructure of large model services like DeepSeek, Training-Free GRPO eliminates fixed serving overhead
and aligns costs directly with actual usage. This pay-as-you-go model is distinctly advantageous in settings
where demand is unpredictable or sparse.

### **5 Related Work**


**LLM Agents.** By leveraging external tools, Large Language Models (LLMs) can overcome inherent limitations, such as lacking real-time knowledge and precise computation. This has spurred the development of
LLM agents that interleave reasoning with actions. Foundational frameworks like ReAct [1] prompt LLMs
to generate explicit chain-of-thought (CoT) and actionable steps, enabling dynamic planning through tool
use. Furthermore, Toolformer [26] demonstrates that LLMs can learn to self-supervise the invocation of APIs
via parameter fine-tuning. Building on these principles, subsequent research has produced sophisticated
single- and multi-agent systems, such as MetaGPT [27], CodeAct [28], and OWL [29], which significantly
enhance the quality of planning, action execution, and tool integration.


**Reinforcement Learning.** Reinforcement learning (RL) has proven highly effective for aligning LLMs with
complex and long-horizon goals. Foundational algorithms like Proximal Policy Optimization (PPO) [30]
employ a policy model for generation and a separate critic model to estimate token-level value. Group
Relative Policy Optimization (GRPO) [17] eliminates the need for a critic by estimating advantages directly
from groups of responses. Recent research try to apply RL to transform LLMs from passive generators
into autonomous agents that learn through environmental interaction. GiGPO [31] implements a two-level


1 `[https://api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing)` . Most of the input tokens qualify for the lower cache hit pricing with
ReAct framework, as each processing step typically involves reusing extensive prior context.


10

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 10 页完整原图](assets/pages/page-010.png)

</details>


## PDF 第 11 页

**<u>Training-Free GRPO</u>**


grouping mechanism for trajectories, enabling precise credit assignment at both the episode and individual
step levels. ReTool [4] uses PPO to train an agent to interleave natural language with code execution for
mathematical reasoning. Chain-of-Agents [16] facilitates multi-agent collaboration within a single model by
using dynamic, context-aware activation of specialized tool and role-playing agents. Furthermore, Tongyi
Deep Research [7] introduces synthetic data generation pipeline and conduct customized on-policy agentic
RL framework. However, such parameter-updating approaches result in prohibitive computational cost,
which typically restricts application to LLMs with fewer than 32B parameters. Moreover, they only achieve
diminishing returns compared to simply using larger, more powerful frozen LLMs. In contrast, our proposed
Training-Free GRPO method seeks to achieve comparable or even better performance on state-of-the-art
LLMs without any parameter updates, drastically reducing both data and computational requirements.


**Training-Free Methods.** A parallel line of research aims to improve LLM behavior at inference time without
updating model weights. The general approach is in-context learning (ICL) [21], which leverages external or
self-generated demonstrations within a prompt to induce desired behaviors. More recent methods introduce
iterative refinement mechanisms. Self-Refine [32] generates an initial output and then uses the same LLM
to provide verbal feedback for subsequent revisions. Similarly, Reflexion [33] incorporates an external
feedback signal to prompt the model for reflection and a new attempt. In-context reinforcement learning
(ICRL) [34, 35] demonstrates that LLMs can learn from scalar reward signals by receiving prompts containing
their past outputs and associated feedback. TextGrad [15] proposes a more general framework, treating
optimization as a process of back-propagating textual feedback through a structured computation graph. A
key characteristic of these methods is their focus on iterative, within-sample improvement for a single query.
In contrast, our Training-Free GRPO more closely mirrors traditional RL by learning from a separate dataset
across multiple epochs to iteratively refine a shared, high-quality experience library for out-of-domain
queries. Furthermore, given each query, unlike self-critique or context updates for a single trajectory, our
method explicitly compares multiple rollouts per query for a semantic advantage to compare different
trajectories in each group, which has been confirmed effective in Section 3.1. Specifically in the context for
optimizing agent systems, Agent KB [36] constructs a shared, hierarchical knowledge base to enable the
reuse of problem-solving experiences across tasks. Unlike the complex reason-retrieve-refine process of
Agent KB, Training-Free GRPO simply injects the learned experiences into the prompt. Moreover, Agent
KB relies on hand-crafted examples and employs an off-policy learning paradigm only once by collecting
trajectories in the different way of online inference. In contrast, our Training-Free GRPO uses a consistent
pipeline and more closely mirrors on-policy RL with multi-epoch learning.

### **6 Conclusion**


In this paper, we introduced Training-Free GRPO, a novel paradigm that shifts RL policy optimization from
the parameter space to the context space. By leveraging group-based rollouts to iteratively distill a semantic
advantage into an evolving experiential knowledge which serves as the token prior, our method successfully
steers the output distribution of a frozen LLM agent, achieving significant performance gains in specialized
domains. Experiments demonstrate that Training-Free GRPO not only surmounts the practical challenges
of data scarcity and high computational cost but also outperforms traditional parameter-tuning methods.
Our work establishes a new, highly efficient pathway for adapting powerful LLM agents, making advanced
agentic capabilities more accessible and practical for real-world applications.


11

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 11 页完整原图](assets/pages/page-011.png)

</details>


## PDF 第 12 页

**<u>Training-Free GRPO</u>**

### **Contributions**


**Authors** Yuzheng Cai <sup>1,2*</sup> Siqi Cai <sup>1*</sup> Yuchen Shi <sup>1*</sup> Zihan Xu <sup>1*</sup> Lichao Chen <sup>1,3</sup> Yulei Qin <sup>1</sup> Xiaoyu
Tan <sup>1</sup> Gang Li <sup>1</sup> Zongyi Li <sup>1</sup> Haojia Lin <sup>1</sup> Yong Mao <sup>1</sup> Ke Li <sup>1�</sup> Xing Sun <sup>1</sup>


**Affiliations** 1Tencent Youtu Lab 2Fudan University 3Xiamen University


***Equal Contributions** Yuzheng Cai Siqi Cai Yuchen Shi Zihan Xu

### **References**


[1] Shunyu Yao, Jeffrey Zhao, Dian Yu, Nan Du, Izhak Shafran, Karthik Narasimhan, and Yuan Cao.

React: Synergizing reasoning and acting in language models. In _International Conference on Learning_
_Representations (ICLR)_, 2023.


[2] AIME. Aime problems and solutions, 2025. URL `[https://artofproblemsolving.com/wiki/index.](https://artofproblemsolving.com/wiki/index.php/AIME_Problems_and_Solutions)`

`[php/AIME_Problems_and_Solutions](https://artofproblemsolving.com/wiki/index.php/AIME_Problems_and_Solutions)` .


[3] DeepSeek-AI. Deepseek-v3 technical report, 2024. URL `[https://arxiv.org/abs/2412.19437](https://arxiv.org/abs/2412.19437)` .


[4] Jiazhan Feng, Shijue Huang, Xingwei Qu, Ge Zhang, Yujia Qin, Baoquan Zhong, Chengquan Jiang,

Jinxin Chi, and Wanjun Zhong. Retool: Reinforcement learning for strategic tool use in llms. _arXiv_
_preprint arXiv:2504.11536_, 2025.


[5] Xinji Mai, Haotian Xu, Weinong Wang, Jian Hu, Yingying Zhang, Wenqiang Zhang, et al. Agent rl

scaling law: Agent rl with spontaneous code execution for mathematical problem solving. _arXiv preprint_
_arXiv:2505.07773_, 2025.


[6] Zhenghai Xue, Longtao Zheng, Qian Liu, Yingru Li, Xiaosen Zheng, Zejun Ma, and Bo An. Sim
pletir: End-to-end reinforcement learning for multi-turn tool-integrated reasoning. _arXiv_ _preprint_
_arXiv:2509.02479_, 2025.


[7] Tongyi DeepResearch Team. Tongyi-deepresearch. `[https://github.com/Alibaba-NLP/DeepResearch](https://github.com/Alibaba-NLP/DeepResearch)`,

2025.


[8] Zhengwei Tao, Jialong Wu, Wenbiao Yin, Junkai Zhang, Baixuan Li, Haiyang Shen, Kuan Li, Liwen

Zhang, Xinyu Wang, Yong Jiang, et al. Webshaper: Agentically data synthesizing via informationseeking formalization. _arXiv preprint arXiv:2507.15061_, 2025.


[9] Bowen Jin, Hansi Zeng, Zhenrui Yue, Jinsung Yoon, Sercan Arik, Dong Wang, Hamed Zamani, and

Jiawei Han. Search-r1: Training llms to reason and leverage search engines with reinforcement learning.
_arXiv preprint arXiv:2503.09516_, 2025.


[10] MiroMind AI Team. Mirothinker: An open-source agentic model series trained for deep research and

complex, long-horizon problem solving. `[https://github.com/MiroMindAI/MiroThinker](https://github.com/MiroMindAI/MiroThinker)`, 2025.


[11] Kechi Zhang, Jia Li, Ge Li, Xianjie Shi, and Zhi Jin. Codeagent: Enhancing code generation with tool
integrated agent systems for real-world repo-level coding challenges. _arXiv preprint arXiv:2401.07339_,
2024.


[12] Dong Huang, Jie M Zhang, Michael Luck, Qingwen Bu, Yuhao Qing, and Heming Cui. Agentcoder: Multi-agent-based code generation with iterative testing and optimisation. _arXiv_ _preprint_
_arXiv:2312.13010_, 2023.


12

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 12 页完整原图](assets/pages/page-012.png)

</details>


## PDF 第 13 页

**<u>Training-Free GRPO</u>**


[13] Shuai Wang, Weiwen Liu, Jingxuan Chen, Yuqi Zhou, Weinan Gan, Xingshan Zeng, Yuhan Che, Shuai

Yu, Xinlong Hao, Kun Shao, et al. Gui agents with foundation models: A comprehensive survey. _arXiv_
_preprint arXiv:2411.04890_, 2024.


[14] Junyang Wang, Haiyang Xu, Haitao Jia, Xi Zhang, Ming Yan, Weizhou Shen, Ji Zhang, Fei Huang, and

Jitao Sang. Mobile-agent-v2: Mobile device operation assistant with effective navigation via multi-agent
collaboration. _Advances in Neural Information Processing Systems_, 37:2686–2710, 2024.


[15] Mert Yuksekgonul, Federico Bianchi, Joseph Boen, Sheng Liu, Pan Lu, Zhi Huang, Carlos Guestrin, and

James Zou. Optimizing generative ai by backpropagating language model feedback. _Nature_, 639(8055):
609–616, 2025.


[16] Weizhen Li, Jianbo Lin, Zhuosong Jiang, Jingyi Cao, Xinpeng Liu, Jiayu Zhang, Zhenqiang Huang,

Qianben Chen, Weichen Sun, Qiexiang Wang, Hongxuan Lu, Tianrui Qin, Chenghao Zhu, Yi Yao,
Shuying Fan, Xiaowan Li, Tiannan Wang, Pai Liu, King Zhu, He Zhu, Dingfeng Shi, Piaohong Wang,
Yeyi Guan, Xiangru Tang, Minghao Liu, Yuchen Eleanor Jiang, Jian Yang, Jiaheng Liu, Ge Zhang, and
Wangchunshu Zhou. Chain-of-agents: End-to-end agent foundation models via multi-agent distillation
and agentic rl. 2025. URL `[https://arxiv.org/abs/2508.13167](https://arxiv.org/abs/2508.13167)` .


[17] Zhihong Shao, Peiyi Wang, Qihao Zhu, Runxin Xu, Junxiao Song, Xiao Bi, Haowei Zhang, Mingchuan

Zhang, YK Li, Yang Wu, et al. Deepseekmath: Pushing the limits of mathematical reasoning in open
language models. _arXiv preprint arXiv:2402.03300_, 2024.


[18] Zichen Liu, Changyu Chen, Wenjun Li, Penghui Qi, Tianyu Pang, Chao Du, Wee Sun Lee, and Min Lin.

Understanding r1-zero-like training: A critical perspective. _arXiv preprint arXiv:2503.20783_, 2025.


[19] Qiying Yu, Zheng Zhang, Ruofei Zhu, Yufeng Yuan, Xiaochen Zuo, Yu Yue, Weinan Dai, Tiantian Fan,

Gaohong Liu, Lingjun Liu, et al. Dapo: An open-source llm reinforcement learning system at scale.
_arXiv preprint arXiv:2503.14476_, 2025.


[20] Chujie Zheng, Shixuan Liu, Mingze Li, Xiong-Hui Chen, Bowen Yu, Chang Gao, Kai Dang, Yuqiong Liu,

Rui Men, An Yang, et al. Group sequence policy optimization. _arXiv preprint arXiv:2507.18071_, 2025.


[21] Tom Brown, Benjamin Mann, Nick Ryder, Melanie Subbiah, Jared D Kaplan, Prafulla Dhariwal, Arvind

Neelakantan, Pranav Shyam, Girish Sastry, Amanda Askell, et al. Language models are few-shot
learners. _Advances in neural information processing systems_, 33:1877–1901, 2020.


[22] An Yang, Anfeng Li, Baosong Yang, Beichen Zhang, Binyuan Hui, Bo Zheng, Bowen Yu, Chang Gao,

Chengen Huang, Chenxu Lv, et al. Qwen3 technical report. _arXiv preprint arXiv:2505.09388_, 2025.


[23] An Yang, Baosong Yang, Beichen Zhang, Binyuan Hui, Bo Zheng, Bowen Yu, Chengyuan Li, Dayiheng

Liu, Fei Huang, Haoran Wei, Huan Lin, Jian Yang, Jianhong Tu, Jianwei Zhang, Jianxin Yang, Jiaxi Yang,
Jingren Zhou, Junyang Lin, Kai Dang, Keming Lu, Keqin Bao, Kexin Yang, Le Yu, Mei Li, Mingfeng
Xue, Pei Zhang, Qin Zhu, Rui Men, Runji Lin, Tianhao Li, Tianyi Tang, Tingyu Xia, Xingzhang Ren,
Xuancheng Ren, Yang Fan, Yang Su, Yichang Zhang, Yu Wan, Yuqiong Liu, Zeyu Cui, Zhenru Zhang,
and Zihan Qiu. Qwen2.5 technical report, 2025. URL `[https://arxiv.org/abs/2412.15115](https://arxiv.org/abs/2412.15115)` .


[24] Jialong Wu, Wenbiao Yin, Yong Jiang, Zhenglin Wang, Zekun Xi, Runnan Fang, Linhai Zhang, Yulan

He, Deyu Zhou, Pengjun Xie, and Fei Huang. Webwalker: Benchmarking llms in web traversal. 2025.
URL `[https://arxiv.org/abs/2501.07572](https://arxiv.org/abs/2501.07572)` .


[25] Qwen Team. Qwq-32b: Embracing the power of reinforcement learning, March 2025. URL `[https:](https://qwenlm.github.io/blog/qwq-32b/)`

`[//qwenlm.github.io/blog/qwq-32b/](https://qwenlm.github.io/blog/qwq-32b/)` .


[26] Timo Schick, Jane Dwivedi-Yu, Roberto Dessì, Roberta Raileanu, Maria Lomeli, Luke Zettlemoyer,

Nicola Cancedda, and Thomas Scialom. Toolformer: Language models can teach themselves to use
tools, 2023. _arXiv preprint arXiv:2302.04761_, 2023.


13

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 13 页完整原图](assets/pages/page-013.png)

</details>


## PDF 第 14 页

**<u>Training-Free GRPO</u>**


[27] Sirui Hong, Mingchen Zhuge, Jonathan Chen, Xiawu Zheng, Yuheng Cheng, Ceyao Zhang, Jinlin Wang,

Zili Wang, Steven Ka Shing Yau, Zijuan Lin, et al. MetaGPT: Meta programming for a multi-agent
collaborative framework. International Conference on Learning Representations, ICLR, 2024.


[28] Xingyao Wang, Yangyi Chen, Lifan Yuan, Yizhe Zhang, Yunzhu Li, Hao Peng, and Heng Ji. Executable

code actions elicit better llm agents. In _Forty-first International Conference on Machine Learning_, 2024.


[29] Mengkang Hu, Yuhang Zhou, Wendong Fan, Yuzhou Nie, Bowei Xia, Tao Sun, Ziyu Ye, Zhaoxuan Jin,

Yingru Li, Qiguang Chen, Zeyu Zhang, Yifeng Wang, Qianshuo Ye, Bernard Ghanem, Ping Luo, and
Guohao Li. OWL: Optimized workforce learning for general multi-agent assistance in real-world task
automation, 2025. URL `[https://arxiv.org/abs/2505.23885](https://arxiv.org/abs/2505.23885)` .


[30] John Schulman, Filip Wolski, Prafulla Dhariwal, Alec Radford, and Oleg Klimov. Proximal policy

optimization algorithms. _arXiv preprint arXiv:1707.06347_, 2017.


[31] Lang Feng, Zhenghai Xue, Tingcong Liu, and Bo An. Group-in-group policy optimization for llm agent

training. _arXiv preprint arXiv:2505.10978_, 2025.


[32] Aman Madaan, Niket Tandon, Prakhar Gupta, Skyler Hallinan, Luyu Gao, Sarah Wiegreffe, Uri Alon,

Nouha Dziri, Shrimai Prabhumoye, Yiming Yang, et al. Self-refine: Iterative refinement with selffeedback. _Advances in Neural Information Processing Systems_, 36:46534–46594, 2023.


[33] Noah Shinn, Federico Cassano, Ashwin Gopinath, Karthik Narasimhan, and Shunyu Yao. Reflexion:

Language agents with verbal reinforcement learning. _Advances in Neural Information Processing Systems_,
36:8634–8652, 2023.


[34] Kefan Song, Amir Moeini, Peng Wang, Lei Gong, Rohan Chandra, Yanjun Qi, and Shangtong Zhang.

Reward is enough: Llms are in-context reinforcement learners. _arXiv preprint arXiv:2506.06303_, 2025.


[35] Giovanni Monea, Antoine Bosselut, Kianté Brantley, and Yoav Artzi. Llms are in-context reinforcement

learners. 2024.


[36] Xiangru Tang, Tianrui Qin, Tianhao Peng, Ziyang Zhou, Daniel Shao, Tingting Du, Xinming Wei, Peng

Xia, Fang Wu, He Zhu, et al. Agent KB: Leveraging cross-domain experience for agentic problem
solving. _arXiv preprint arXiv:2507.06229_, 2025.


14

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 14 页完整原图](assets/pages/page-014.png)

</details>


## PDF 第 15 页

**<u>Training-Free GRPO</u>**

### **A Case Study**


On math reasoning and web searching scenarios, we provide examples illustrating how Training-Free GRPO
enhances ReAct [1] with DeepSeek-V3.1-Terminus and corresponding tools.


#### A.1 Experience-Guided Tool-Integrated Math Reasoning


We consider a geometric configuration with two rectangles _ABCD_ and _EFGH_ where _D_, _E_, _C_, _F_ are collinear
in that order, and _A_, _D_, _H_, _G_ are concyclic. Given _BC_ = 16, _AB_ = 107, _FG_ = 17, _EF_ = 184, the task is to
determine _CE_ .



![](assets/figures/2510.08191-14-0.png)























**Figure 5.** Example trajectory without experience in Math Reasoning.



**Baseline (without experiences).** As shown in Figure 5, the unassisted agent initializes a coordinate system
with _D_ = (0, 0) and models _ABCD_ as axis-aligned. For _EFGH_, it places _E_ = ( _x f_ _−_ 184, 0), _F_ = ( _x f_, 0) and,
critically, sets _G_ = ( _x f_, +17), _H_ = ( _x f_ _−_ 184, +17), i.e., with a positive vertical orientation for the short side.
It then enforces the four-point concyclicity of _A_ (0, 16), _D_ (0, 0), _G_, _H_ via a determinant condition and solves
for _x f_, yielding _x f_ _≈_ 184.092 and consequently _xe_ = _x f_ _−_ 184 _≈_ 0.092. From this, it reports _CE ≈_ 106.9076

_√_

and an “exact” expression 199 _−_ 8481.



_√_



8481.



This trajectory exhibits three systemic issues: (i) misinterpretation of the vertical orientation (wrong sign
for the _y_ -coordinates of _G_, _H_ ), (ii) inconsistent handling of the order _D_ - _E_ - _C_ - _F_ and the lack of a unified
parameterization for segment relations, and (iii) absence of systematic, comprehensive post-solution verification—i.e., no integrated check that the final coordinates simultaneously satisfy rectangle dimensions. These
issues lead to an incorrect cyclic constraint (e.g., an intermediate relation of the form _x_ ( _x_ + 184) = 17) and


15

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 15 页完整原图](assets/pages/page-015.png)

</details>


## PDF 第 16 页

**<u>Training-Free GRPO</u>**


acceptance of a spurious solution without full geometric verification. Note that although _CE ≈_ 106.91 lies
within 0 _<_ _CE_ _<_ 107, this alone does not validate the solution; the critical failure was the lack of holistic
consistency checks across all problem constraints.



![](assets/figures/2510.08191-15-0.png)

**Figure 6.** Example trajectory with experiences in Math Reasoning.


**Enhanced** **(With** **Experiences).** Refer to Figure 6, with a curated experience pool, the agent follows a
structured pipeline:


- Directional ordering ([29]) and boundedness validation ([1]): It fixes the order _D_ - _E_ - _C_ - _F_ on a line and sets


16

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 16 页完整原图](assets/pages/page-016.png)

</details>


## PDF 第 17 页

**<u>Training-Free GRPO</u>**


_CE_ = _x_ with 0 _<_ _x_ _<_ 107, ensuring _E_ lies on segment _DC_ and _F_ lies beyond _C_ .


- Segment-addition parameterization ([37]): It uses _DE_ + _EC_ = _DC_ = _AB_ = 107 and _EC_ + _CF_ = _EF_ = 184
to obtain _DE_ = 107 _−_ _x_, _CF_ = 184 _−_ _x_, and places _D_ = (0, 0), _E_ = (107 _−_ _x_, 0), _C_ = (107, 0), _F_ =
(291 _−_ _x_, 0).


- Consistent vertical orientation and cyclic modeling: Noting _A_ = (0, 16), _D_ = (0, 0), it orients the short
side downward ( _FG_ = 17) so _H_ = (107 _−_ _x_, _−_ 17), _G_ = (291 _−_ _x_, _−_ 17). Using the circle equation
_x_ <sup>2</sup> + _y_ <sup>2</sup> + _Dx_ + _Ey_ + _F_ = 0 with _A_ and _D_ yields _F_ = 0, _E_ = _−_ 16. Substituting _H_ and _G_, subtracting the
two equations gives _D_ = 2 _x −_ 398; back-substitution reduces to the quadratic _x_ <sup>2</sup> _−_ 398 _x_ + 30576 = 0, with
discriminant 398 <sup>2</sup> _−_ 4 _·_ 30576 = 36100 = 190 <sup>2</sup> and roots _x_ = 104, 294.


- Root selection and full verification ([1], [7]): Applying 0 _<_ _x_ _<_ 107 filters out _x_ = 294, selecting _x_ = 104.
The agent then verifies all constraints: _DE_ = 107 _−_ 104 = 3, _CF_ = 184 _−_ 104 = 80, _EF_ = 184, _FG_ = 17,
and confirms that the circle _x_ <sup>2</sup> + _y_ <sup>2</sup> _−_ 190 _x −_ 16 _y_ = 0 passes through _A_ = (0, 16), _D_ = (0, 0), _H_ = (3, _−_ 17),
_G_ = (187, _−_ 17).


**Comparative** **Analysis.** This case reveals a clear causal link between experience-guided behaviors and
correctness. Experience [29] eliminates directional ambiguity and enforces the correct collinearity order,
directly addressing the baseline’s misplacement of _G_, _H_ . Experience [37] induces a clean single-variable
parameterization ( _DE_ = 107 _−_ _x_, _CF_ = 184 _−_ _x_ ), which simplifies the cyclic constraint to a solvable
quadratic. Experience [1] imposes a necessary boundedness filter (0 _<_ _x_ _<_ 107) to discard extraneous roots.
Finally, experience [7] mandates comprehensive post-solution verification (rectangle dimensions, collinearity,
concyclicity), preventing acceptance of spurious solutions.


Compared to the unassisted trajectory, the experience-informed reasoning corrects the vertical orientation,
resolves ordering and parameterization inconsistencies, and installs principled validation gates. This case
demonstrates the positive impact of integrating domain-specific experiences on reliability and accuracy in
tool-integrated mathematical reasoning.


#### A.2 Experience-Guided Web Searching


We consider a web searching task from WebWalkerQA: quantify 2024 rewards for (i) creators in the Creator
Program (weekly amount), and (ii) players in the Play-2-Airdrop during Private Beta 4 (total pool and
duration).


**Baseline (without experiences).** As summarized in Figure 7, the unassisted agent issues multiple broad
searches and relies heavily on result snippets and third-party summaries, delaying clicks into authoritative
pages. It eventually opens the PB4 registration post to confirm “Play-2-Airdrop Campaign: 200,000 ILV over
six months,” but continues to scan snippets for the Creator Program value without opening the relevant
official post. Connection errors to one official page cause the agent to revert to broad searches rather than
alternative primary-source strategies (e.g., site-specific queries or adjacent official posts). The trajectory
remains incomplete: it reports the Play-2-Airdrop figure but fails to confirm the Creator Program’s “100 ILV
weekly” from an official source, yielding an incorrect/incomplete answer.


**Enhanced** **(With** **Experiences).** Refer to Figure 8. With a curated experience pool, the agent follows a
disciplined pipeline: (1) prioritize official sources ([14], [4]) and open the PB4 overview and registration
posts to extract the “200,000 ILV over six months” and Testnet/Mainnet allocation structure; (2) refine search
terms to target formal titles ([2], [12], [1]) and open “The Illuvium Creator Program Is Getting An Upgrade!”;
(3) extract the exact line “The prize pool of 100 ILV tokens awaits participating Creators each week,” and (4)
synthesize both verified statements into a complete answer aligned with the question requirements ([25]).


17

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 17 页完整原图](assets/pages/page-017.png)

</details>


## PDF 第 18 页

**<u>Training-Free GRPO</u>**


This results in the correct, fully supported output: creators earn 100 ILV weekly; players have a 200,000 ILV
pool distributed over six months in PB4’s Play-2-Airdrop.



![](assets/figures/2510.08191-17-0.png)

**Figure 7.** Example trajectory without experiences in Web Searching.


**Comparative Analysis.** Experience-guided behaviors directly address baseline deficiencies: primary source
prioritization ([14], [4]) removes reliance on snippets and third-party coverage; document identification ([1])
and iterative refinement ([2], [12]) ensure the agent locates and opens the exact Creator Program post; partial
match evaluation ([25]) steers the agent to confirm numerical claims at their authoritative origin. In contrast,
the baseline wastes context on searches without content acquisition, leaves critical values unverified, and
produces an incomplete answer.


18

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 18 页完整原图](assets/pages/page-018.png)

</details>


## PDF 第 19 页

**<u>Training-Free GRPO</u>**



![](assets/figures/2510.08191-18-0.png)

**Figure 8.** Example trajectory with experiences in Web Searching.


19

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 19 页完整原图](assets/pages/page-019.png)

</details>


## PDF 第 20 页

**<u>Training-Free GRPO</u>**

### **B Prompts**


In this appendix, we provide the prompts used in math reasoning tasks. Figures 9 and 10 present the prompts
for solving math tasks. Figures 11 and 12 are used in group relative semantic advantage. Figure 13 works for
optimizing the experiential knowledge _E_ .



![](assets/figures/2510.08191-19-0.png)





**Figure 9.** System prompt for ReAct framework in Math Reasoning.



![](assets/figures/2510.08191-19-1.png)





**Figure 10.** Prompt for supplementing math problems with experiential knowledge _E_ .



![](assets/figures/2510.08191-19-2.png)





**Figure 11.** Prompt for summarizing each trajectory in Math Reasoning.


20

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 20 页完整原图](assets/pages/page-020.png)

</details>


## PDF 第 21 页

**<u>Training-Free GRPO</u>**



![](assets/figures/2510.08191-20-0.png)



**Figure 12.** Prompt for group advantage computation in Math Reasoning.


21

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 21 页完整原图](assets/pages/page-021.png)

</details>


## PDF 第 22 页

**<u>Training-Free GRPO</u>**



![](assets/figures/2510.08191-21-0.png)

**Figure 13.** Prompt for optimizing experiential knowledge _E_ based on group advantages in the same batch in Math
Reasoning.


22

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 22 页完整原图](assets/pages/page-022.png)

</details>


## PDF 第 23 页

**<u>Training-Free GRPO</u>**

### **C Examples of Learned Experiences**


In this appendix, we provide some examples in Figure 14, which are extracted from 48 learned experiences
by Training-Free GRPO with tool use in Math Reasoning.



![](assets/figures/2510.08191-22-0.png)





**Figure 14.** Example of learned experiences from Training-Free GRPO with tool use in Math Reasoning.


23

<details>
<summary>本页完整原图（核对图表与公式）</summary>

![PDF 第 23 页完整原图](assets/pages/page-023.png)

</details>
