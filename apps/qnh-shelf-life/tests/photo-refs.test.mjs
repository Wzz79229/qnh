import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRecord,sanitizeState} from '../dist/core.mjs';
test('photo-backed records retain canonical private references without permitting alternate paths',()=>{
  const id='12345678-1234-4123-8123-123456789012';
  const input={name:'原味酸奶',expiryDate:'2026-10-20',quantity:1,photoRefs:[{id,path:`photos/${id}.jpg`,secret:'discard'}]};
  const result=validateRecord(input);assert.equal(result.valid,true);assert.deepEqual(result.record.photoRefs,[{id,path:`photos/${id}.jpg`}]);
  const state=sanitizeState({schemaVersion:1,records:[result.record],settings:{urgentDays:7,warningDays:30},updatedAt:new Date().toISOString()});assert.deepEqual(state.records[0].photoRefs,result.record.photoRefs);
  for(const refs of [[{id,path:'../other.jpg'}],[{id,path:`photos/${id}.jpg`},{id,path:`photos/${id}.jpg`}],{},[...Array(4)].map((_,n)=>({id,path:`photos/${id}.jpg`}))])assert.equal(validateRecord({...input,photoRefs:refs}).valid,false);
});
