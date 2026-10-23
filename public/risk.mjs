// Shared calculation only. The server independently recalculates all submitted inputs.
export const PAPER_RULES = { symbol:'BTC-USD', stepSize:0.000001, tickSize:0.1, minQty:0.000001, maxQty:0.1, minNotional:5, precision:6, source:'Paper assumptions' };
export function calculatePlan(input, rules = PAPER_RULES) {
  if(!input || !['long','short'].includes(input.direction)) throw Error('Choose long or short.');
  const number=(key,min,max)=>{const n=Number(input[key]);if(input[key]===''||input[key]===null||!Number.isFinite(n)||n<min||n>max)throw Error(`Invalid ${key}.`);return n};
  const entry=number('entry',1,10000000),stop=number('stop',1,10000000),budget=number('budget',0.1,1000),leverage=number('leverage',1,10),feeBps=number('feeBps',0,100),slippageBps=number('slippageBps',0,500);
  if(!Number.isInteger(leverage))throw Error('Leverage must be a whole number from 1 to 10.');
  if((input.direction==='long'&&stop>=entry)||(input.direction==='short'&&stop<=entry))throw Error('For a long, stop must be below entry. For a short, stop must be above entry.');
  const target=input.target===''||input.target==null?null:number('target',1,10000000);
  if(target!==null&&((input.direction==='long'&&target<=entry)||(input.direction==='short'&&target>=entry)))throw Error('Take profit must be on the profitable side of entry.');
  for(const value of [entry,stop,...(target?[target]:[])])if(Math.abs(value/rules.tickSize-Math.round(value/rules.tickSize))>0.00001)throw Error(`Prices must use increments of $${rules.tickSize}.`);
  for(const value of [entry,stop,...(target?[target]:[])])if((Number.isFinite(rules.minPrice)&&value<rules.minPrice)||(Number.isFinite(rules.maxPrice)&&rules.maxPrice>0&&value>rules.maxPrice))throw Error(`Prices must be within Strike's market range: $${rules.minPrice} to $${rules.maxPrice}.`);
  const distance=Math.abs(entry-stop),feeRate=feeBps/10000,slippageRate=slippageBps/10000;
  const unitFees=(entry+stop)*feeRate,unitSlippage=stop*slippageRate;
  const raw=budget/(distance+unitFees+unitSlippage);
  const cap=Math.min(rules.maxQty,0.1,10000/entry);
  const quantity=Number((Math.floor(Math.min(raw,cap)/rules.stepSize)*rules.stepSize).toFixed(rules.precision));
  if(quantity<rules.minQty||quantity*entry<rules.minNotional)throw Error('This budget produces an order below the market minimum. Increase the budget or adjust the stop.');
  const notional=quantity*entry,priceLoss=quantity*distance,estimatedFees=quantity*unitFees,slippageBuffer=quantity*unitSlippage,intendedLoss=priceLoss+estimatedFees+slippageBuffer;
  const targetProfit=target===null?null:quantity*Math.abs(target-entry)-quantity*(entry+target)*feeRate;
  const warnings=['Stop execution, gaps, funding, liquidation and fees can make actual losses exceed this estimate.','Margin is an estimate; Strike determines actual requirements.'];
  if(distance/entry>=0.8/leverage)warnings.push('The stop is far from entry for this leverage. Liquidation may occur before the stop; reduce leverage and check Strike.');
  if(raw>cap)warnings.push('Position capped at the smaller of 0.1 BTC, $10,000 notional and the market limit.');
  if(targetProfit!==null&&targetProfit<=0)warnings.push('Estimated fees exceed the gross target profit.');
  return {symbol:'BTC-USD',direction:input.direction,entry,stop,target,budget,leverage,feeBps,slippageBps,quantity,quantityText:quantity.toFixed(rules.precision),notional,margin:notional/leverage,priceLoss,estimatedFees,slippageBuffer,intendedLoss,targetProfit,rewardRisk:targetProfit===null?null:targetProfit/intendedLoss,stopDistancePercent:distance/entry*100,capped:raw>cap,warnings,rules};
}
