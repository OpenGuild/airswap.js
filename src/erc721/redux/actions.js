import { submitERC721Approve } from './contractFunctionActions'
import { SWAP_LEGACY_CONTRACT_ADDRESS } from '../../constants'

export const approveERC721 = (tokenAddress, tokenId) =>
  submitERC721Approve({
    contractAddress: tokenAddress,
    tokenId,
    to: SWAP_LEGACY_CONTRACT_ADDRESS,
  })
